const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CollectingCarsScraper = require("../src/rare/collectingcars-scraper");

// Курсы на день продажи в тестах — свои, чтобы не ходить в сеть: фунт = 2, евро = 1.5, франк = 1.2, австралийский доллар = 0.5.
const FAKE_RATES = { USD: 1, GBP: 2, EUR: 1.5, CHF: 1.2, AUD: 0.5, NZD: 0.4 };
const fakeFx = {
  calls: [],
  async convert(amount, currency, soldAt) {
    this.calls.push({ amount, currency, soldAt });
    const rate = FAKE_RATES[currency];
    if (!rate)
      throw new Error(`нет курса ${currency}`);
    return { salePrice: Math.round(amount * rate), fxRate: rate, fxDate: String(soldAt).slice(0, 10) };
  },
};

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-rare-collectingcars-"));

const hitsResponse = (docs, found = docs.length) => ({
  ok: true,
  json: async () => ({ results: [{ found, hits: docs.map(document => ({ document })) }] }),
});

/*
 * Поддельный поиск Collecting Cars: по стадии в filter_by отдаёт либо
 * «идущие» (live), либо «проданные» (sold) документы — по страницам, как
 * настоящий Typesense. Все запросы складываются в requests.
 */
const fakeSearch = ({ live = [], sold = [] } = {}) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const search = JSON.parse(init.body).searches[0];
    requests.push({ url, search });
    const source = search.filter_by.includes("listingStage:live") ? live : sold;
    const start = (search.page - 1) * search.per_page;
    return hitsResponse(source.slice(start, start + search.per_page), source.length);
  };
  return { fetchImpl, requests };
};

const liveDoc = (overrides = {}) => ({
  slug: "2021-mercedes-amg-w213-e63-s-estate-1",
  title: "2021 Mercedes-AMG (W213) E63 S Estate",
  mainImageUrl: "https://images.collectingcars.com/090968/AS-03-08-08.jpg",
  currencyCode: "gbp",
  currentBid: 54000,
  dtStageEndsUTC: "2026-10-05 12:00:00",
  productMake: "Mercedes-AMG",
  modelName: "E-Class",
  ...overrides,
});

const soldDoc = (n, overrides = {}) => ({
  slug: `2012-bentley-continental-gtc-v8-${n}`,
  title: "2012 Bentley Continental GTC V8",
  mainImageUrl: "https://images.collectingcars.com/091987/2-9-26KR9.jpg",
  currencyCode: "aud",
  priceSold: 80100,
  isSoldPriceHidden: false,
  productMake: "Bentley",
  productYear: "2012",
  modelName: "Continental GT",
  dtSoldUTC: "2026-10-02 06:47:24",
  ...overrides,
});

const scraperWith = (api, extra = {}) => {
  const dataDir = tmpDir();
  return new CollectingCarsScraper({ dataDir, fetchImpl: api.fetchImpl, fx: fakeFx, log: () => {}, ...extra });
};

const cleanup = scraper => fs.rmSync(scraper.dataDir, { recursive: true, force: true });

test("run() maps a live listing to a RareLot, converting its native currency to USD", async () => {
  const scraper = scraperWith(fakeSearch({ live: [liveDoc()] }));

  const lots = await scraper.run();
  assert.equal(lots.length, 1);

  const lot = lots[0];
  assert.equal(lot.id, "collectingcars-2021-mercedes-amg-w213-e63-s-estate-1");
  assert.equal(lot.source, "Collecting Cars");
  assert.equal(lot.sourceUrl, "https://collectingcars.com/for-sale/2021-mercedes-amg-w213-e63-s-estate-1");
  assert.equal(lot.title, "2021 Mercedes-AMG (W213) E63 S Estate");
  assert.equal(lot.make, "Mercedes-AMG");
  assert.equal(lot.currentBid, Math.round(54000 * 1.32338)); // £ → USD
  assert.equal(lot.photoUrl, `${liveDoc().mainImageUrl}?w=1280&q=75`);

  cleanup(scraper);
});

test("run() converts every currency seen on the site (gbp, eur, aud, nzd, usd, chf)", async () => {
  const scraper = scraperWith(fakeSearch({
    live: [
      liveDoc({ slug: "a", currencyCode: "aud", currentBid: 41250 }),
      liveDoc({ slug: "b", currencyCode: "nzd", currentBid: 52500 }),
      liveDoc({ slug: "c", currencyCode: "usd", currentBid: 31000 }),
      liveDoc({ slug: "d", currencyCode: "eur", currentBid: 20000 }),
      liveDoc({ slug: "e", currencyCode: "chf", currentBid: 10000 }),
    ],
  }));

  const lots = await scraper.run();
  const bySlug = Object.fromEntries(lots.map(l => [l.sourceUrl.split("/").pop(), l.currentBid]));

  assert.equal(bySlug.a, Math.round(41250 * 0.69505));
  assert.equal(bySlug.b, Math.round(52500 * 0.56153));
  assert.equal(bySlug.c, 31000); // USD 1:1
  assert.equal(bySlug.d, Math.round(20000 * 1.12979));
  assert.equal(bySlug.e, Math.round(10000 * 1.1972));

  cleanup(scraper);
});

test("run() takes closesAt from the platform's exact end time (UTC), and flags a lot closing within 48h", async () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const scraper = scraperWith(
    fakeSearch({ live: [liveDoc({ slug: "soon", dtStageEndsUTC: "2026-10-01 13:30:00" }), liveDoc({ slug: "later", dtStageEndsUTC: "2026-10-09 13:30:00" })] }),
    { now: () => now },
  );

  const [soon, later] = await scraper.run();
  assert.equal(soon.closesAt, "2026-10-01T13:30:00.000Z");
  assert.equal(soon.status, "closing");
  assert.equal(later.status, "open");

  cleanup(scraper);
});

test("run() keeps a lot the platform still calls live as closing, not ended, once its scheduled end has passed", async () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const scraper = scraperWith(fakeSearch({ live: [liveDoc({ dtStageEndsUTC: "2026-10-01 11:59:00" })] }), { now: () => now });

  const [lot] = await scraper.run();
  assert.equal(lot.status, "closing");

  cleanup(scraper);
});

test("run() asks only for live car auctions, and skips lots with no usable price", async () => {
  const api = fakeSearch({
    live: [
      liveDoc(),
      liveDoc({ slug: "no-bid", currentBid: null }),
      liveDoc({ slug: "odd-currency", currencyCode: "sek" }),
    ],
  });
  const scraper = scraperWith(api);

  const lots = await scraper.run();
  assert.deepEqual(lots.map(l => l.id), ["collectingcars-2021-mercedes-amg-w213-e63-s-estate-1"]);

  const liveRequest = api.requests.find(r => r.search.filter_by.includes("listingStage:live"));
  assert.match(liveRequest.url, /multi_search/);
  assert.match(liveRequest.search.filter_by, /lotType:car/);
  assert.match(liveRequest.search.filter_by, /saleFormat:auction/);

  cleanup(scraper);
});

test("fetchLiveDocs pages through everything when there are more live lots than one page", async () => {
  const live = Array.from({ length: 300 }, (_, i) => liveDoc({ slug: `car-${i}` }));
  const scraper = scraperWith(fakeSearch({ live }));

  const docs = await scraper.fetchLiveDocs();
  assert.equal(docs.length, 300);

  cleanup(scraper);
});

test("run() reports only genuinely new lots to alerts.checkAfterRun", async () => {
  const calls = [];
  const alerts = { checkAfterRun: async (args) => { calls.push(args); } };
  const api = fakeSearch({ live: [liveDoc()] });
  const scraper = scraperWith(api, { alerts });

  await scraper.run();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].newLots.map(l => l.id), ["collectingcars-2021-mercedes-amg-w213-e63-s-estate-1"]);

  scraper.fetchImpl = fakeSearch({ live: [liveDoc(), liveDoc({ slug: "second-car" })] }).fetchImpl;
  await scraper.run();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].newLots.map(l => l.id), ["collectingcars-second-car"]);

  cleanup(scraper);
});

test("run() writes a failed status and rethrows when the search fails", async () => {
  const scraper = scraperWith({ fetchImpl: async () => ({ ok: false, status: 502 }) });

  await assert.rejects(() => scraper.run());
  const status = scraper.readStatus();
  assert.equal(status.ok, false);
  assert.match(status.error, /502/);

  cleanup(scraper);
});

test("updateSoldArchive archives a sold car, converting the sale price to USD at the sale-date rate and keeping the original", async () => {
  const api = fakeSearch({ sold: [soldDoc(1)] });
  const scraper = scraperWith(api);

  assert.equal(await scraper.updateSoldArchive(), 1);

  const [lot] = scraper.readSold();
  assert.equal(lot.id, "collectingcars-2012-bentley-continental-gtc-v8-1");
  assert.equal(lot.sourceUrl, "https://collectingcars.com/for-sale/2012-bentley-continental-gtc-v8-1");
  assert.equal(lot.make, "Bentley");
  assert.equal(lot.year, 2012);
  assert.equal(lot.salePrice, Math.round(80100 * 0.5));
  assert.equal(lot.salePriceLocal, 80100);
  assert.equal(lot.currency, "AUD");
  assert.equal(lot.fxRate, 0.5);
  assert.equal(lot.fxDate, "2026-10-02");
  assert.equal(lot.sold, true);
  assert.equal(lot.soldAt, "2026-10-02T06:47:24.000Z");
  assert.equal(lot.photoUrl, "https://images.collectingcars.com/091987/2-9-26KR9.jpg?w=1280&q=75");
  assert.match(api.requests[0].search.filter_by, /listingStage:sold/);
  assert.match(api.requests[0].search.filter_by, /lotType:car/);
  assert.match(api.requests[0].search.filter_by, /saleFormat:auction/);

  cleanup(scraper);
});

test("updateSoldArchive skips hidden prices and currencies it has no rate for", async () => {
  const scraper = scraperWith(fakeSearch({
    sold: [
      soldDoc(1),
      soldDoc(2, { isSoldPriceHidden: true }),
      soldDoc(3, { currencyCode: "sek" }),
      soldDoc(4, { priceSold: null }),
    ],
  }));

  await scraper.updateSoldArchive();
  assert.deepEqual(scraper.readSold().map(l => l.id), ["collectingcars-2012-bentley-continental-gtc-v8-1"]);

  cleanup(scraper);
});

test("updateSoldArchive pages until a page has nothing new, and never duplicates", async () => {
  const pages = [];
  const first = Array.from({ length: 500 }, (_, i) => soldDoc(i));
  const scraper = scraperWith({
    // страницы 1–2 — новые, страница 3 — повтор уже знакомых → стоп
    fetchImpl: async (url, init) => {
      const { page } = JSON.parse(init.body).searches[0];
      pages.push(page);
      return hitsResponse(page === 1 ? first.slice(0, 250) : page === 2 ? first.slice(250) : first.slice(0, 250));
    },
  });

  assert.equal(await scraper.updateSoldArchive(), 500);
  assert.deepEqual(pages, [1, 2, 3]);

  pages.length = 0;
  assert.equal(await scraper.updateSoldArchive(), 0);
  assert.deepEqual(pages, [1]);
  assert.equal(scraper.readSold().length, 500);

  cleanup(scraper);
});

test("run() still succeeds when the sold-archive request fails", async () => {
  const live = fakeSearch({ live: [liveDoc()] });
  const scraper = scraperWith({
    fetchImpl: async (url, init) => JSON.parse(init.body).searches[0].filter_by.includes("listingStage:sold")
      ? { ok: false, status: 500 }
      : live.fetchImpl(url, init),
  });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);
  assert.equal(scraper.readStatus().ok, true);
  assert.deepEqual(scraper.readSold(), []);

  cleanup(scraper);
});

test("updateSoldArchive leaves a sold lot out (to retry next run) when the sale-date rate is unavailable", async () => {
  const scraper = scraperWith(fakeSearch({ sold: [soldDoc(1)] }), { fx: { convert: async () => { throw new Error("сервис курсов недоступен"); } } });

  assert.equal(await scraper.updateSoldArchive(), 0);
  assert.deepEqual(scraper.readSold(), []);

  cleanup(scraper);
});

test("updateSoldArchive re-prices archived lots that still carry the old fixed-rate price, using the sale-date rate", async () => {
  const scraper = scraperWith(fakeSearch());
  fs.mkdirSync(scraper.dataDir, { recursive: true });
  fs.writeFileSync(scraper.soldFile(), JSON.stringify({
    old: { id: "old", soldAt: "2020-05-05T10:00:00.000Z", salePrice: 1, salePriceLocal: 1000, currency: "GBP" },
    usd: { id: "usd", soldAt: "2020-05-05T10:00:00.000Z", salePrice: 500, salePriceLocal: 500, currency: "USD" },
  }));

  await scraper.updateSoldArchive();

  const byId = Object.fromEntries(scraper.readSold().map(l => [l.id, l]));
  assert.equal(byId.old.salePrice, 2000);
  assert.equal(byId.old.fxDate, "2020-05-05");
  assert.equal(byId.usd.salePrice, 500); // доллары не трогаем

  cleanup(scraper);
});
