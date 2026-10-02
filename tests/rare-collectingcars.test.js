const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CollectingCarsScraper = require("../src/rare/collectingcars-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-rare-collectingcars-"));

// Архив продаж ходит в сеть сам — в тестах про активные лоты подсовываем пустой ответ, чтобы не лезть наружу.
const soldResponse = docs => ({ ok: true, json: async () => ({ results: [{ hits: docs.map(document => ({ document })) }] }) });
const noSold = async () => soldResponse([]);

const card = (overrides = {}) => ({
  href: "/for-sale/2021-mercedes-amg-w213-e63-s-estate-1",
  imgAlt: "2021 Mercedes-AMG (W213) E63 S Estate",
  imgSrc: "https://images.collectingcars.com/090968/AS-03-08-08.jpg?w=3840&q=75",
  text: "NO RESERVE\nBOOSTED\n2021 MERCEDES-AMG (W213) E63 S ESTATE\n\nCURRENT BID\n\n£54,000\n\n00:02:56\nLONDON\n36 BIDS",
  ...overrides,
});

test("run() maps a card to a RareLot, converting its native currency to USD", async () => {
  const dataDir = tmpDir();
  const scraper = new CollectingCarsScraper({ fetchImpl: noSold, dataDir, fetchCards: async () => [card()], log: () => {} });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);

  const lot = lots[0];
  assert.equal(lot.id, "collectingcars-2021-mercedes-amg-w213-e63-s-estate-1");
  assert.equal(lot.source, "Collecting Cars");
  assert.equal(lot.sourceUrl, "https://collectingcars.com/for-sale/2021-mercedes-amg-w213-e63-s-estate-1");
  assert.equal(lot.title, "2021 Mercedes-AMG (W213) E63 S Estate"); // регистр из alt картинки, не КАПС карточки
  assert.equal(lot.make, "Mercedes-AMG");
  assert.equal(lot.currentBid, Math.round(54000 * 1.32338)); // £ → USD
  assert.equal(lot.photoUrl, card().imgSrc);
});

test("run() converts every currency symbol seen on the site (£, €, A$, NZ$, US$)", async () => {
  const dataDir = tmpDir();
  const scraper = new CollectingCarsScraper({ fetchImpl: noSold,
    dataDir,
    fetchCards: async () => [
      card({ href: "/for-sale/a", imgAlt: "Car A", text: "CURRENT BID\n\nA$41,250\n\n12:20:36\nWhyalla, SA\n62 Bids" }),
      card({ href: "/for-sale/b", imgAlt: "Car B", text: "CURRENT BID\n\nNZ$52,500\n\n11:45:36\nAuckland\n36 Bids" }),
      card({ href: "/for-sale/c", imgAlt: "Car C", text: "CURRENT BID\n\nUS$31,000\n\n17:15:36\nSharjah\n18 Bids" }),
      card({ href: "/for-sale/d", imgAlt: "Car D", text: "CURRENT BID\n\n€20,000\n\n05:00:00\nParis\n5 Bids" }),
    ],
    log: () => {},
  });

  const lots = await scraper.run();
  const byHref = Object.fromEntries(lots.map(l => [l.sourceUrl.split("/").pop(), l.currentBid]));

  assert.equal(byHref.a, Math.round(41250 * 0.69505));
  assert.equal(byHref.b, Math.round(52500 * 0.56153));
  assert.equal(byHref.c, 31000); // US$ 1:1
  assert.equal(byHref.d, Math.round(20000 * 1.12979));
});

test("run() computes closesAt from the live countdown, not a fixed date", async () => {
  const dataDir = tmpDir();
  const now = Date.parse("2026-10-01T12:00:00Z");
  const scraper = new CollectingCarsScraper({ fetchImpl: noSold,
    dataDir,
    now: () => now,
    fetchCards: async () => [card({ text: "CURRENT BID\n\n£1,000\n\n01:30:00\nLondon\n1 Bids" })],
    log: () => {},
  });

  const [lot] = await scraper.run();
  assert.equal(lot.closesAt, new Date(now + (1 * 3600 + 30 * 60) * 1000).toISOString());
  assert.equal(lot.status, "closing"); // 1ч30м — внутри окна "скоро закрывается"
});

test("run() skips cards without a recognisable price/countdown block", async () => {
  const dataDir = tmpDir();
  const scraper = new CollectingCarsScraper({ fetchImpl: noSold,
    dataDir,
    fetchCards: async () => [
      card(),
      { href: "/for-sale/no-bid-yet", imgAlt: "Coming Soon Car", imgSrc: "https://x/y.jpg", text: "COMING SOON\nSome Car\nStarts in 3 days" },
    ],
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);
  assert.equal(lots[0].sourceUrl, "https://collectingcars.com/for-sale/2021-mercedes-amg-w213-e63-s-estate-1");
});

test("run() reports only genuinely new lots to alerts.checkAfterRun", async () => {
  const dataDir = tmpDir();
  const calls = [];
  const alerts = { checkAfterRun: async (args) => { calls.push(args); } };

  const scraper = new CollectingCarsScraper({ fetchImpl: noSold,
    dataDir,
    alerts,
    fetchCards: async () => [card()],
    log: () => {},
  });

  await scraper.run();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].newLots.map(l => l.id), ["collectingcars-2021-mercedes-amg-w213-e63-s-estate-1"]);

  scraper.fetchCards = async () => [card(), card({ href: "/for-sale/second-car", imgAlt: "Second Car" })];
  await scraper.run();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].newLots.map(l => l.id), ["collectingcars-second-car"]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() writes a failed status and rethrows when fetching fails", async () => {
  const dataDir = tmpDir();
  const scraper = new CollectingCarsScraper({ fetchImpl: noSold,
    dataDir,
    fetchCards: async () => { throw new Error("прокси недоступен"); },
    log: () => {},
  });

  await assert.rejects(() => scraper.run());
  const status = scraper.readStatus();
  assert.equal(status.ok, false);
  assert.match(status.error, /прокси/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

const soldDoc = (n, overrides = {}) => ({
  id: String(n),
  slug: `2012-bentley-continental-gtc-v8-${n}`,
  title: "2012 Bentley Continental GTC V8",
  mainImageUrl: "https://images.collectingcars.com/091987/2-9-26KR9.jpg",
  currencyCode: "aud",
  priceSold: 80100,
  isSoldPriceHidden: false,
  saleFormat: "auction",
  lotType: "car",
  productMake: "Bentley",
  productYear: "2012",
  modelName: "Continental GT",
  dtSoldUTC: "2026-10-02 06:47:24",
  tsSoldUTC: 1790923644,
  ...overrides,
});

test("updateSoldArchive archives a sold car, converting the sale price to USD and keeping the original", async () => {
  const dataDir = tmpDir();
  const requests = [];
  const scraper = new CollectingCarsScraper({ dataDir, log: () => {} });
  scraper.fetchImpl = async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return soldResponse([soldDoc(1)]); };

  assert.equal(await scraper.updateSoldArchive(), 1);

  const [lot] = scraper.readSold();
  assert.equal(lot.id, "collectingcars-2012-bentley-continental-gtc-v8-1");
  assert.equal(lot.sourceUrl, "https://collectingcars.com/for-sale/2012-bentley-continental-gtc-v8-1");
  assert.equal(lot.make, "Bentley");
  assert.equal(lot.year, 2012);
  assert.equal(lot.salePrice, Math.round(80100 * 0.69505));
  assert.equal(lot.salePriceLocal, 80100);
  assert.equal(lot.currency, "AUD");
  assert.equal(lot.sold, true);
  assert.equal(lot.soldAt, "2026-10-02T06:47:24Z");
  assert.equal(lot.photoUrl, "https://images.collectingcars.com/091987/2-9-26KR9.jpg");
  assert.match(requests[0].url, /multi_search/);
  assert.match(requests[0].body.searches[0].filter_by, /listingStage:sold/);
  assert.match(requests[0].body.searches[0].filter_by, /lotType:car/);
  assert.match(requests[0].body.searches[0].filter_by, /saleFormat:auction/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("updateSoldArchive skips hidden prices and currencies it has no rate for", async () => {
  const dataDir = tmpDir();
  const scraper = new CollectingCarsScraper({ dataDir, log: () => {} });
  scraper.fetchImpl = async () => soldResponse([
    soldDoc(1),
    soldDoc(2, { isSoldPriceHidden: true }),
    soldDoc(3, { currencyCode: "sek" }),
    soldDoc(4, { priceSold: null }),
  ]);

  await scraper.updateSoldArchive();
  assert.deepEqual(scraper.readSold().map(l => l.id), ["collectingcars-2012-bentley-continental-gtc-v8-1"]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("updateSoldArchive pages until a page has nothing new, and never duplicates", async () => {
  const dataDir = tmpDir();
  const pages = [];
  const fullPage = from => Array.from({ length: 250 }, (_, i) => soldDoc(from + i));
  const scraper = new CollectingCarsScraper({ dataDir, log: () => {} });
  scraper.fetchImpl = async (url, init) => {
    const page = JSON.parse(init.body).searches[0].page;
    pages.push(page);
    return soldResponse(page === 1 ? fullPage(1) : page === 2 ? fullPage(251) : fullPage(1));
  };

  assert.equal(await scraper.updateSoldArchive(), 500);
  assert.deepEqual(pages, [1, 2, 3]);

  pages.length = 0;
  assert.equal(await scraper.updateSoldArchive(), 0);
  assert.deepEqual(pages, [1]);
  assert.equal(scraper.readSold().length, 500);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() still succeeds when the sold-archive request fails", async () => {
  const dataDir = tmpDir();
  const scraper = new CollectingCarsScraper({ dataDir, fetchCards: async () => [card()], log: () => {} });
  scraper.fetchImpl = async () => ({ ok: false, status: 500 });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);
  assert.equal(scraper.readStatus().ok, true);
  assert.deepEqual(scraper.readSold(), []);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
