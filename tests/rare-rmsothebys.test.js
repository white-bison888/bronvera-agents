const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RmSothebysScraper = require("../src/rare/rmsothebys-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-rare-rmsothebys-"));

const upcomingHtml = codes => `<html><body>${codes.map(c => `<a href="/auctions/${c}/lots/">${c}</a>`).join("")}</body></html>`;

const eventHtml = ({ endDate = "2026-10-07" } = {}) =>
  `<html><body><script type="application/ld+json">{"@context":"https://schema.org","@type":" Event","headline":"The Hershey Auction 2026","startDate":"2026-10-05","endDate":"${endDate}"}</script></body></html>`;

const searchItem = (overrides = {}) => ({
  id: "a1",
  publicName: "1918 Rauch & Lang Model B26 Brougham",
  value: "$150,000 - $175,000 USD",
  link: "https://rmsothebys.com/auctions/hf26/lots/r0098-1918-rauch-lang-model-b26-brougham/",
  crop: "https://cdn.rmsothebys.com/photo.webp",
  ...overrides,
});

const searchResponse = (items, { page = 0, totalPages = 1 } = {}) => ({
  items,
  pager: { totalItems: items.length, currentPage: page + 1, pageSize: 100, totalPages },
});

/*
 * Подпись «Chassis No.» и значение — в разных div (как на настоящем
 * сайте), а оценка в USD — первой строкой мультивалютного блока,
 * независимо от родной валюты лота.
 */
const lotDetailHtml = ({ chassis = "80492", usdMin = "150,000", usdMax = "175,000" } = {}) => `<html><body>
  <p>$${usdMin} - $${usdMax} USD</p>
  <p>&#xA3;110,000 - &#xA3;130,000 GBP</p>
  <div class="idlabel">Chassis No.</div>
  <div class="iddata">${chassis}</div>
</body></html>`;

const stubFetch = ({ codes = ["hf26"], itemsByCode = {}, closesAtByCode = {}, detailHtml = () => lotDetailHtml() } = {}) => async (url, options = {}) => {
  const href = String(url);

  if (href.includes("/upcoming/"))
    return { ok: true, status: 200, text: async () => upcomingHtml(codes) };

  if (href.includes("/api/search/SearchLots")) {
    const body = JSON.parse(options.body);
    const items = itemsByCode[body.Auction] || itemsByCode[body.Auction?.toLowerCase()] || [];
    return { ok: true, status: 200, json: async () => searchResponse(items) };
  }

  if (/\/auctions\/[a-z0-9]+\/$/i.test(href)) {
    const code = href.match(/\/auctions\/([a-z0-9]+)\/$/i)[1];
    return { ok: true, status: 200, text: async () => eventHtml({ endDate: closesAtByCode[code] || "2026-10-07" }) };
  }

  // Любой другой адрес — страница конкретного лота.
  return { ok: true, status: 200, text: async () => detailHtml(href) };
};

test("fetchUpcomingAuctionCodes reads codes from /upcoming/, deduplicated", async () => {
  const scraper = new RmSothebysScraper({
    dataDir: tmpDir(),
    fetchImpl: stubFetch({ codes: ["hf26", "lf26", "hf26"] }),
    log: () => {},
  });

  const codes = await scraper.fetchUpcomingAuctionCodes();
  assert.deepEqual([...codes].sort(), ["hf26", "lf26"]);
});

test("fetchAuctionClosesAt reads endDate from the auction's own schema.org Event markup", async () => {
  const scraper = new RmSothebysScraper({
    dataDir: tmpDir(),
    fetchImpl: stubFetch({ closesAtByCode: { hf26: "2026-12-25" } }),
    log: () => {},
  });

  const closesAt = await scraper.fetchAuctionClosesAt("hf26");
  assert.equal(closesAt, new Date("2026-12-25T23:59:59Z").toISOString());
});

test("run() maps a search item to a RareLot with USD estimate (from the lot page, not list value) and no live bid", async () => {
  const dataDir = tmpDir();
  const scraper = new RmSothebysScraper({
    dataDir,
    fetchImpl: stubFetch({ codes: ["hf26"], itemsByCode: { HF26: [searchItem()] } }),
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);

  const lot = lots[0];
  assert.equal(lot.id, "rmsothebys-a1");
  assert.equal(lot.source, "RM Sotheby's");
  assert.equal(lot.make, "Rauch & Lang");
  assert.equal(lot.estimateMin, 150000);
  assert.equal(lot.estimateMax, 175000);
  assert.equal(lot.currentBid, null); // предпродажный каталог — живой ставки нет
  assert.equal(lot.vin, "80492"); // шасси со страницы лота
  assert.equal(lot.closesAt, new Date("2026-10-07T23:59:59Z").toISOString()); // дата со страницы аукциона

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() extracts the USD line even when the lot's own currency is not USD", async () => {
  const dataDir = tmpDir();
  const scraper = new RmSothebysScraper({
    dataDir,
    fetchImpl: stubFetch({
      codes: ["lf26"],
      itemsByCode: { LF26: [searchItem({ id: "gbp1", value: "£2,000,000 - £2,500,000 GBP", link: "https://rmsothebys.com/auctions/lf26/lots/r0037-2004-porsche-carrera-gt/" })] },
      detailHtml: () => lotDetailHtml({ usdMin: "2,700,000", usdMax: "3,400,000" }),
    }),
    log: () => {},
  });

  const [lot] = await scraper.run();
  assert.equal(lot.estimateMin, 2700000);
  assert.equal(lot.estimateMax, 3400000);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() derives status from the auction's closesAt", async () => {
  const dataDir = tmpDir();
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);

  const scraper = new RmSothebysScraper({
    dataDir,
    fetchImpl: stubFetch({ codes: ["hf26"], itemsByCode: { HF26: [searchItem()] }, closesAtByCode: { hf26: soon } }),
    log: () => {},
  });

  const [lot] = await scraper.run();
  assert.equal(lot.status, "closing");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("fetchAuctionCarLots walks every page up to totalPages", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("SearchLots")) {
      const search = new URL(url).searchParams;
      const page = Number(search.get("page"));
      calls.push(page);
      const item = searchItem({ id: `a${page}`, link: `https://rmsothebys.com/auctions/hf26/lots/lot-${page}/` });
      return { ok: true, status: 200, json: async () => searchResponse([item], { page, totalPages: 3 }) };
    }
    return { ok: true, status: 200, text: async () => lotDetailHtml() };
  };

  const scraper = new RmSothebysScraper({ dataDir: tmpDir(), fetchImpl, log: () => {} });
  const items = await scraper.fetchAuctionCarLots("hf26");

  assert.deepEqual(calls, [0, 1, 2]);
  assert.deepEqual(items.map(i => i.id), ["a0", "a1", "a2"]);
});

test("fetchActiveListings keeps going when one auction's SearchLots call fails, and skips empty auctions", async () => {
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/upcoming/"))
      return { ok: true, status: 200, text: async () => upcomingHtml(["bad26", "empty26", "hf26"]) };
    if (href.includes("SearchLots")) {
      const body = JSON.parse(options.body);
      if (body.Auction === "BAD26")
        return { ok: false, status: 500 };
      if (body.Auction === "EMPTY26")
        return { ok: true, status: 200, json: async () => searchResponse([]) };
      return { ok: true, status: 200, json: async () => searchResponse([searchItem()]) };
    }
    if (/\/auctions\/[a-z0-9]+\/$/i.test(href))
      return { ok: true, status: 200, text: async () => eventHtml() };
    return { ok: true, status: 200, text: async () => lotDetailHtml() };
  };

  const scraper = new RmSothebysScraper({ dataDir: tmpDir(), fetchImpl, log: () => {} });
  const lots = await scraper.fetchActiveListings();
  assert.equal(lots.length, 1); // bad26 сорвался, empty26 без лотов, hf26 всё равно собрался
});

test("run() reports only genuinely new lots to alerts.checkAfterRun", async () => {
  const dataDir = tmpDir();
  const calls = [];
  const alerts = { checkAfterRun: async (args) => { calls.push(args); } };

  const scraper = new RmSothebysScraper({
    dataDir,
    alerts,
    fetchImpl: stubFetch({ codes: ["hf26"], itemsByCode: { HF26: [searchItem({ id: "a1" })] } }),
    log: () => {},
  });

  await scraper.run();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].newLots.map(l => l.id), ["rmsothebys-a1"]);

  scraper.fetchImpl = stubFetch({ codes: ["hf26"], itemsByCode: { HF26: [searchItem({ id: "a1" }), searchItem({ id: "a2", link: "https://rmsothebys.com/auctions/hf26/lots/lot-a2/" })] } });
  await scraper.run();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].newLots.map(l => l.id), ["rmsothebys-a2"]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() writes a failed status and rethrows when /upcoming/ itself fails", async () => {
  const dataDir = tmpDir();
  const scraper = new RmSothebysScraper({
    dataDir,
    fetchImpl: async () => ({ ok: false, status: 500 }),
    log: () => {},
  });

  await assert.rejects(() => scraper.run());
  const status = scraper.readStatus();
  assert.equal(status.ok, false);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

const soldItem = (overrides = {}) => searchItem({
  id: "s1",
  publicName: "1953 Jaguar XK 120 Drophead Coupe",
  value: "$61,600 USD",
  valueType: "Sold",
  sold: true,
  link: "https://rmsothebys.com/auctions/az26/lots/r0024-1953-jaguar-xk-120-drophead-coupe/",
  ...overrides,
});

// Страницы /results/ и /past-auctions/ + то же, что у stubFetch (SearchLots и страницы аукционов).
const stubSoldFetch = ({ resultsCodes = ["az26"], pastCodes = [], ...rest } = {}) => {
  const base = stubFetch({ codes: [], ...rest });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/results/"))
      return { ok: true, status: 200, text: async () => upcomingHtml(resultsCodes) };
    if (href.endsWith("/past-auctions/"))
      return { ok: true, status: 200, text: async () => upcomingHtml(pastCodes) };
    return base(url, options);
  };
  return { fetchImpl, calls };
};

test("updateSoldArchive archives sold lots with the real price, date of the auction and year", async () => {
  const dataDir = tmpDir();
  const stub = stubSoldFetch({ itemsByCode: { AZ26: [soldItem()] }, closesAtByCode: { az26: "2026-01-23" } });
  const scraper = new RmSothebysScraper({ dataDir, fetchImpl: stub.fetchImpl, log: () => {} });

  assert.equal(await scraper.updateSoldArchive(), 1);

  const [lot] = scraper.readSold();
  assert.equal(lot.id, "rmsothebys-s1");
  assert.equal(lot.title, "1953 Jaguar XK 120 Drophead Coupe");
  assert.equal(lot.make, "Jaguar");
  assert.equal(lot.year, 1953);
  assert.equal(lot.salePrice, 61600);
  assert.equal(lot.currency, "USD");
  assert.equal(lot.sold, true);
  assert.equal(lot.soldAt, "2026-01-23T00:00:00.000Z");
  assert.equal(lot.auctionCode, "az26");
  assert.equal(lot.sourceUrl, soldItem().link);
  assert.equal(lot.photoUrl, "https://cdn.rmsothebys.com/photo.webp");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("updateSoldArchive converts £ € CHF to USD and keeps the original price", async () => {
  const dataDir = tmpDir();
  const stub = stubSoldFetch({
    itemsByCode: {
      AZ26: [
        soldItem({ id: "g", value: "£15,525 GBP" }),
        soldItem({ id: "e", value: "€92,000 EUR" }),
        soldItem({ id: "c", value: "CHF71,300" }),
      ],
    },
  });
  const scraper = new RmSothebysScraper({ dataDir, fetchImpl: stub.fetchImpl, log: () => {} });

  await scraper.updateSoldArchive();
  const byId = Object.fromEntries(scraper.readSold().map(l => [l.id, l]));

  assert.equal(byId["rmsothebys-g"].salePrice, Math.round(15525 * 1.32338));
  assert.equal(byId["rmsothebys-g"].salePriceLocal, 15525);
  assert.equal(byId["rmsothebys-g"].currency, "GBP");
  assert.equal(byId["rmsothebys-e"].salePrice, Math.round(92000 * 1.12979));
  assert.equal(byId["rmsothebys-c"].salePrice, Math.round(71300 * 1.1972));

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("updateSoldArchive skips unsold lots (value is an estimate range), sealed lots and non-cars without a year", async () => {
  const dataDir = tmpDir();
  const stub = stubSoldFetch({
    itemsByCode: {
      AZ26: [
        soldItem({ id: "ok" }),
        soldItem({ id: "ns", value: "$2,000,000 - $3,000,000 USD", valueType: "Not Sold", sold: false }),
        soldItem({ id: "sealed", value: "", valueType: "", sold: true }),
        soldItem({ id: "poster", publicName: "'Thunderball' James Bond Limited-Edition Framed Film Poster", value: "£300 GBP" }),
      ],
    },
  });
  const scraper = new RmSothebysScraper({ dataDir, fetchImpl: stub.fetchImpl, log: () => {} });

  await scraper.updateSoldArchive();
  assert.deepEqual(scraper.readSold().map(l => l.id), ["rmsothebys-ok"]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("updateSoldArchive does not re-fetch a settled auction, but re-checks a fresh one", async () => {
  const dataDir = tmpDir();
  let now = Date.parse("2026-02-20T00:00:00Z");
  const stub = stubSoldFetch({ resultsCodes: ["az26"], itemsByCode: { AZ26: [soldItem()] }, closesAtByCode: { az26: "2026-01-23" } });
  const scraper = new RmSothebysScraper({ dataDir, fetchImpl: stub.fetchImpl, now: () => now, log: () => {} });

  await scraper.updateSoldArchive();
  const searchCalls = () => stub.calls.filter(href => href.includes("SearchLots")).length;
  assert.equal(searchCalls(), 1);

  // аукцион закончился больше трёх дней назад и уже проверен после этого — повторно не трогаем
  await scraper.updateSoldArchive();
  assert.equal(searchCalls(), 1);

  // свежий аукцион (конец «сегодня») перепроверяем при каждом заходе
  const fresh = stubSoldFetch({ resultsCodes: ["new26"], itemsByCode: { NEW26: [soldItem({ id: "n1" })] }, closesAtByCode: { new26: "2026-02-20" } });
  scraper.fetchImpl = fresh.fetchImpl;
  await scraper.updateSoldArchive();
  await scraper.updateSoldArchive();
  assert.equal(fresh.calls.filter(href => href.includes("SearchLots")).length, 2);
  assert.equal(scraper.readSold().length, 2); // без дублей

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("updateSoldArchive takes at most maxAuctions per run, newest results first", async () => {
  const dataDir = tmpDir();
  const stub = stubSoldFetch({
    resultsCodes: ["a1", "a2"],
    pastCodes: ["a3", "a4"],
    itemsByCode: { A1: [soldItem({ id: "x1" })], A2: [soldItem({ id: "x2" })], A3: [soldItem({ id: "x3" })], A4: [soldItem({ id: "x4" })] },
  });
  const scraper = new RmSothebysScraper({ dataDir, fetchImpl: stub.fetchImpl, log: () => {} });

  await scraper.updateSoldArchive({ maxAuctions: 3 });
  assert.deepEqual(scraper.readSold().map(l => l.id).sort(), ["rmsothebys-x1", "rmsothebys-x2", "rmsothebys-x3"]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() still succeeds when the sold-archive fetch fails", async () => {
  const dataDir = tmpDir();
  const base = stubFetch({ codes: ["hf26"], itemsByCode: { HF26: [searchItem()] } });
  const scraper = new RmSothebysScraper({
    dataDir,
    fetchImpl: async (url, options) => String(url).endsWith("/results/") ? { ok: false, status: 500 } : base(url, options),
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);
  assert.equal(scraper.readStatus().ok, true);
  assert.deepEqual(scraper.readSold(), []);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
