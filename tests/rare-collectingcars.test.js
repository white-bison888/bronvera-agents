const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CollectingCarsScraper = require("../src/rare/collectingcars-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-rare-collectingcars-"));

const card = (overrides = {}) => ({
  href: "/for-sale/2021-mercedes-amg-w213-e63-s-estate-1",
  imgAlt: "2021 Mercedes-AMG (W213) E63 S Estate",
  imgSrc: "https://images.collectingcars.com/090968/AS-03-08-08.jpg?w=3840&q=75",
  text: "NO RESERVE\nBOOSTED\n2021 MERCEDES-AMG (W213) E63 S ESTATE\n\nCURRENT BID\n\n£54,000\n\n00:02:56\nLONDON\n36 BIDS",
  ...overrides,
});

test("run() maps a card to a RareLot, converting its native currency to USD", async () => {
  const dataDir = tmpDir();
  const scraper = new CollectingCarsScraper({ dataDir, fetchCards: async () => [card()], log: () => {} });

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
  const scraper = new CollectingCarsScraper({
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
  const scraper = new CollectingCarsScraper({
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
  const scraper = new CollectingCarsScraper({
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

  const scraper = new CollectingCarsScraper({
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
  const scraper = new CollectingCarsScraper({
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
