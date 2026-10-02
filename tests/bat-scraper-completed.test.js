const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BatScraper = require("../src/rare/bat-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-bat-completed-"));

const FAKE_RATES = { USD: 1, GBP: 2, EUR: 1.5 };
const fakeFx = {
  async convert(amount, currency, soldAt) {
    const rate = FAKE_RATES[currency];
    if (!rate)
      throw new Error(`нет курса ${currency}`);
    return { salePrice: Math.round(amount * rate), fxRate: rate, fxDate: String(soldAt).slice(0, 10) };
  },
};

const NOW_S = Math.floor(Date.parse("2026-10-01T12:00:00Z") / 1000);

const completed = (n, overrides = {}) => ({
  id: 1000 + n,
  title: "1993 Chevrolet Corvette ZR-1",
  url: `https://bringatrailer.com/listing/1993-chevrolet-corvette-zr-1-${n}/`,
  excerpt: "This 1993 Chevrolet Corvette ZR-1 is finished in Bright Aqua Metallic over Light Gray leather and has 24k miles with a six-speed manual transmission.",
  currency: "USD",
  current_bid: 26500,
  sold_text: "Sold for USD $26,500 <span> on 10/1/2026 </span>",
  sold_text_timestamp: NOW_S - n * 60,
  thumbnail_url: "https://bringatrailer.com/wp-content/uploads/x.jpeg?w=470",
  ...overrides,
});

const pageOf = items => ({ ok: true, status: 200, json: async () => ({ items, items_total: items.length, pages_total: 1 }) });

const scraperWith = (fetchImpl, extra = {}) => new BatScraper({ dataDir: tmpDir(), fetchImpl, fx: fakeFx, sleep: async () => {}, log: () => {}, ...extra });
const cleanup = scraper => fs.rmSync(scraper.dataDir, { recursive: true, force: true });

test("updateSoldFromCompleted archives a sold lot with price, date, colour, mileage and transmission", async () => {
  const scraper = scraperWith(async () => pageOf([completed(1)]));

  await scraper.updateSoldFromCompleted({ eras: ["1990"] });

  const [lot] = scraper.readSold();
  assert.equal(lot.id, "bat-1001");
  assert.equal(lot.source, "Bring a Trailer");
  assert.equal(lot.make, "Chevrolet");
  assert.equal(lot.year, 1993);
  assert.equal(lot.salePrice, 26500);
  assert.equal(lot.sold, true);
  assert.equal(lot.soldAt, new Date((NOW_S - 60) * 1000).toISOString());
  assert.equal(lot.exteriorColor, "Bright Aqua Metallic");
  assert.equal(lot.colorGroup, "Синий");
  assert.equal(lot.mileage, 24000);
  assert.equal(lot.transmissionKind, "manual");
  assert.equal(lot.photoUrl, "https://bringatrailer.com/wp-content/uploads/x.jpeg?w=470");
  assert.equal(lot.sourceUrl, completed(1).url);

  cleanup(scraper);
});

test("«Bid to» is archived as not sold (reserve not met); withdrawn lots and motorcycles are skipped", async () => {
  const scraper = scraperWith(async () => pageOf([
    completed(1, { sold_text: "Bid to USD $20,000 <span> on 10/1/2026 </span>", current_bid: 20000 }),
    completed(2, { sold_text: "Withdrawn by BaT <span> on 10/1/2026 </span>" }),
    completed(3, { title: "1978 Ducati 900SD Darmah" }),
    completed(4, { title: "2007 Harley-Davidson Ultra Classic Electra Glide" }),
  ]));

  await scraper.updateSoldFromCompleted({ eras: ["1990"] });

  const lots = scraper.readSold();
  assert.deepEqual(lots.map(l => [l.id, l.sold]), [["bat-1001", false]]);

  cleanup(scraper);
});

test("a lot sold in pounds is priced in USD at the sale-date rate, original kept", async () => {
  const scraper = scraperWith(async () => pageOf([completed(1, { currency: "GBP", current_bid: 14500, sold_text: "Sold for GBP £14,500 <span> on 10/1/2026 </span>" })]));

  await scraper.updateSoldFromCompleted({ eras: ["1990"] });

  const [lot] = scraper.readSold();
  assert.equal(lot.salePrice, 29000);
  assert.equal(lot.salePriceLocal, 14500);
  assert.equal(lot.currency, "GBP");
  assert.equal(lot.fxRate, 2);

  cleanup(scraper);
});

test("a daily run stops paging an era once a page has nothing new; a deep backfill keeps going", async () => {
  const pages = [];
  const full = start => Array.from({ length: 60 }, (_, i) => completed(start + i));
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    return pageOf(page === 1 ? full(1) : page === 2 ? full(1) : full(100));
  };
  const scraper = scraperWith(fetchImpl);

  await scraper.updateSoldFromCompleted({ eras: ["1990"], maxPages: 5 });
  assert.deepEqual(pages, [1, 2]); // вторая страница — повтор первой → стоп

  pages.length = 0;
  await scraper.updateSoldFromCompleted({ eras: ["1990"], maxPages: 3, stopWhenKnown: false });
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(scraper.readSold().length, 120);

  cleanup(scraper);
});

test("a lot already archived without colour/mileage gets them filled in, not duplicated", async () => {
  const scraper = scraperWith(async () => pageOf([completed(1)]));
  fs.mkdirSync(scraper.dataDir, { recursive: true });
  fs.writeFileSync(scraper.soldFile(), JSON.stringify({ "bat-1001": { id: "bat-1001", salePrice: 26500, mileage: null, exteriorColor: null, transmission: "6-ступенчатая механика" } }));

  await scraper.updateSoldFromCompleted({ eras: ["1990"] });

  const lots = scraper.readSold();
  assert.equal(lots.length, 1);
  assert.equal(lots[0].exteriorColor, "Bright Aqua Metallic");
  assert.equal(lots[0].mileage, 24000);
  assert.equal(lots[0].transmission, "6-ступенчатая механика"); // уже известное не затираем

  cleanup(scraper);
});

test("«Slow down your API calls» is waited out and retried instead of failing the run", async () => {
  let calls = 0;
  const waits = [];
  const scraper = scraperWith(async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, status: 400, json: async () => ({ code: "rest_invalid_param", message: "Slow down your API calls" }) }
      : pageOf([completed(1)]);
  }, { sleep: async ms => { waits.push(ms); } });

  await scraper.updateSoldFromCompleted({ eras: ["1990"] });

  assert.equal(calls, 2);
  assert.ok(waits.some(ms => ms >= 30_000));
  assert.equal(scraper.readSold().length, 1);

  cleanup(scraper);
});

test("an unrecoverable error from BaT is thrown (and run() treats it as non-fatal)", async () => {
  const scraper = scraperWith(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  await assert.rejects(() => scraper.updateSoldFromCompleted({ eras: ["1990"] }), /500/);
  cleanup(scraper);
});
