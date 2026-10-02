const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HemmingsScraper = require("../src/rare/hemmings-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-rare-hemmings-"));

const listing = (overrides = {}) => ({
  id: 36153,
  title: "1969 Ford Mustang",
  long_title: "Highly Original: 1969 Ford Mustang Hardtop With a 302 V8",
  url: "https://www.hemmings.com/auction/1969-ford-mustang-palm-desert-ca-959637",
  make: { name: "Ford", id: 582, slug: "ford" },
  model: { name: "Mustang", id: 8365, slug: "mustang" },
  year: 1969,
  vin: "9F02A123456",
  current_bid: "$12,000",
  status: "live",
  end_date: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
  dealer: null,
  certified_dealer: false,
  thumbnail: { md: { "4:3": "https://thumbor-auction.hmn.com/sample-md.jpg" } },
  ...overrides,
});

const searchResponse = (results, { page = 1, totalCount = results.length } = {}) => ({
  total_count: totalCount,
  results_per_page: 100,
  page,
  results,
  aggregations: {},
});

test("run() maps a listing to a RareLot using the structured make/model/vin fields", async () => {
  const dataDir = tmpDir();
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async () => ({ ok: true, json: async () => searchResponse([listing()]) }),
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);

  const lot = lots[0];
  assert.equal(lot.id, "hemmings-36153");
  assert.equal(lot.source, "Hemmings");
  assert.equal(lot.title, "Highly Original: 1969 Ford Mustang Hardtop With a 302 V8");
  assert.equal(lot.make, "Ford");
  assert.equal(lot.model, "Mustang");
  assert.equal(lot.vin, "9F02A123456");
  assert.equal(lot.currentBid, 12000);
  assert.equal(lot.sourceUrl, listing().url);
  assert.equal(lot.photoUrl, "https://thumbor-auction.hmn.com/sample-md.jpg");
  assert.equal(lot.status, "open");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() falls back to title when long_title is missing, and leaves make/model/vin null when absent", async () => {
  const dataDir = tmpDir();
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async () => ({ ok: true, json: async () => searchResponse([listing({ long_title: null, make: null, model: null, vin: null })]) }),
    log: () => {},
  });

  const [lot] = await scraper.run();
  assert.equal(lot.title, "1969 Ford Mustang");
  assert.equal(lot.make, null);
  assert.equal(lot.model, null);
  assert.equal(lot.vin, null);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() marks dealer listings as Дилер and private listings as null", async () => {
  const dataDir = tmpDir();
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async () => ({ ok: true, json: async () => searchResponse([
      listing({ id: 1, certified_dealer: true }),
      listing({ id: 2, dealer: null, certified_dealer: false }),
    ]) }),
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.find(l => l.id === "hemmings-1").ownerType, "Дилер");
  assert.equal(lots.find(l => l.id === "hemmings-2").ownerType, null);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() marks a lot closing within 48h, and still closing (not ended) once end_date has passed but the platform still calls it live", async () => {
  const dataDir = tmpDir();
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async () => ({ ok: true, json: async () => searchResponse([
      listing({ id: 1, end_date: soon }),
      listing({ id: 2, end_date: past, status: "live" }),
    ]) }),
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.find(l => l.id === "hemmings-1").status, "closing");
  // Тот же класс бага, что нашли и починили на Cars & Bids 01.10 (баг от
  // Mikita): расписанное end_date в прошлом не значит, что площадка уже
  // подвела итог — "ended" здесь показал бы ставку, которая ещё может
  // вырасти.
  assert.equal(lots.find(l => l.id === "hemmings-2").status, "closing");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() marks a lot ended once the platform itself says so, not just by time", async () => {
  const dataDir = tmpDir();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async () => ({ ok: true, json: async () => searchResponse([listing({ end_date: past, status: "sold" })]) }),
    log: () => {},
  });

  const [lot] = await scraper.run();
  assert.equal(lot.status, "ended");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("fetchActiveListings fetches additional pages only when total_count exceeds the first page", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const page = Number(params.get("page"));
    calls.push(page);
    if (page === 1)
      return { ok: true, json: async () => searchResponse(Array.from({ length: 100 }, (_, i) => listing({ id: i })), { totalCount: 120 }) };
    return { ok: true, json: async () => searchResponse(Array.from({ length: 20 }, (_, i) => listing({ id: 100 + i })), { page, totalCount: 120 }) };
  };

  const scraper = new HemmingsScraper({ dataDir: tmpDir(), fetchImpl, log: () => {} });
  const items = await scraper.fetchActiveListings();

  assert.deepEqual(calls, [1, 2]);
  assert.equal(items.length, 120);
});

test("fetchActiveListings makes a single call when everything fits on the first page", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(1);
    return { ok: true, json: async () => searchResponse([listing()]) };
  };

  const scraper = new HemmingsScraper({ dataDir: tmpDir(), fetchImpl, log: () => {} });
  await scraper.fetchActiveListings();
  assert.equal(calls.length, 1);
});

/*
 * adtype=cars-for-sale не отсекает автомобилию внутри аукционов (дилерские
 * таблички, неоновые вывески, часы) — у них единообразно model.slug ===
 * "other" и model.name === null, а у настоящих машин модель есть всегда.
 */
test("fetchActiveListings drops memorabilia/signs/watches masquerading as a make with no real model", async () => {
  const scraper = new HemmingsScraper({
    dataDir: tmpDir(),
    fetchImpl: async () => ({ ok: true, json: async () => searchResponse([
      listing({ id: 1 }), // настоящая машина — проходит
      listing({ id: 2, title: "2010 BMW ", long_title: "BMW M Dealership Lighted Sign", model: { name: null, id: null, slug: "other" }, vin: null }),
      listing({ id: 3, title: "2010 Heuer ", long_title: "Tag Heuer Formula 1 Chronograph", model: { name: null, id: null, slug: "other" }, vin: null }),
    ]) }),
    log: () => {},
  });

  const items = await scraper.fetchActiveListings();
  assert.deepEqual(items.map(i => i.id), [1]);
});

test("run() reports only genuinely new lots to alerts.checkAfterRun", async () => {
  const dataDir = tmpDir();
  const calls = [];
  const alerts = { checkAfterRun: async (args) => { calls.push(args); } };

  const scraper = new HemmingsScraper({
    dataDir,
    alerts,
    fetchImpl: async () => ({ ok: true, json: async () => searchResponse([listing({ id: 1 })]) }),
    log: () => {},
  });

  await scraper.run();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].newLots.map(l => l.id), ["hemmings-1"]);

  scraper.fetchImpl = async () => ({ ok: true, json: async () => searchResponse([listing({ id: 1 }), listing({ id: 2 })]) });
  await scraper.run();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].newLots.map(l => l.id), ["hemmings-2"]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() writes a failed status and rethrows on a non-OK response", async () => {
  const dataDir = tmpDir();
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async () => ({ ok: false, status: 401 }),
    log: () => {},
  });

  await assert.rejects(() => scraper.run());
  const status = scraper.readStatus();
  assert.equal(status.ok, false);
  assert.match(status.error, /401/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

const soldItem = (id, overrides = {}) => listing({
  id,
  status: "sold",
  current_bid: "$17,000",
  current_price: "$18,900",
  sold_at: "2026-10-01T16:17:05-04:00",
  end_date: "2026-10-01T16:17:05-04:00",
  ...overrides,
});

test("updateSoldArchive archives sold listings with the real sale price (current_price, not the last bid)", async () => {
  const dataDir = tmpDir();
  const urls = [];
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async (url) => { urls.push(url); return { ok: true, json: async () => searchResponse([soldItem(7)]) }; },
    log: () => {},
  });

  assert.equal(await scraper.updateSoldArchive(), 1);

  const [lot] = scraper.readSold();
  assert.equal(lot.id, "hemmings-7");
  assert.equal(lot.salePrice, 18900);
  assert.equal(lot.sold, true);
  assert.equal(lot.make, "Ford");
  assert.equal(lot.year, 1969);
  assert.equal(lot.soldAt, "2026-10-01T16:17:05-04:00");
  assert.equal(lot.photoUrl, "https://thumbor-auction.hmn.com/sample-md.jpg");
  assert.match(decodeURIComponent(urls[0]), /listing_status\[\]=sold/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("updateSoldArchive keeps accumulating, never duplicates, and stops paging once a page has nothing new", async () => {
  const dataDir = tmpDir();
  const pages = [];
  const fullPage = (from) => Array.from({ length: 50 }, (_, i) => soldItem(from + i));
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async (url) => {
      const params = new URL(url).searchParams;
      if (params.get("transmission_type[]"))
        return { ok: true, json: async () => searchResponse([]) }; // списки по коробке — не предмет этого теста
      const page = Number(params.get("page"));
      pages.push(page);
      return { ok: true, json: async () => searchResponse(page === 1 ? fullPage(1) : page === 2 ? fullPage(51) : fullPage(1)) };
    },
    log: () => {},
  });

  // первый заход: страницы 1 и 2 новые, страница 3 — повтор (ничего нового) → стоп
  assert.equal(await scraper.updateSoldArchive(), 100);
  assert.deepEqual(pages, [1, 2, 3]);

  // второй заход: первая же страница уже вся знакома → одна выборка, ничего не добавлено
  pages.length = 0;
  assert.equal(await scraper.updateSoldArchive(), 0);
  assert.deepEqual(pages, [1]);
  assert.equal(scraper.readSold().length, 100);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("updateSoldArchive skips memorabilia with no real model and items without a price", async () => {
  const dataDir = tmpDir();
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async () => ({
      ok: true,
      json: async () => searchResponse([
        soldItem(1),
        soldItem(2, { model: { name: "Other", slug: "other" } }),
        soldItem(3, { current_price: null, current_bid: null }),
      ]),
    }),
    log: () => {},
  });

  await scraper.updateSoldArchive();
  assert.deepEqual(scraper.readSold().map(l => l.id), ["hemmings-1"]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() still succeeds when the sold-archive fetch fails", async () => {
  const dataDir = tmpDir();
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async (url) => decodeURIComponent(url).includes("listing_status[]=sold")
      ? { ok: false, status: 500 }
      : { ok: true, json: async () => searchResponse([listing()]) },
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);
  assert.equal(scraper.readStatus().ok, true);
  assert.deepEqual(scraper.readSold(), []);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("updateSoldArchive marks transmission from the manual/auto filtered lists, leaving unknown ones unmarked", async () => {
  const dataDir = tmpDir();
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async (url) => {
      const filter = new URL(url).searchParams.get("transmission_type[]");
      const items = filter === "manual" ? [soldItem(1)] : filter === "auto" ? [soldItem(2)] : [soldItem(1), soldItem(2), soldItem(3)];
      return { ok: true, json: async () => searchResponse(items) };
    },
    log: () => {},
  });

  await scraper.updateSoldArchive();

  const byId = Object.fromEntries(scraper.readSold().map(l => [l.id, l]));
  assert.equal(byId["hemmings-1"].transmissionKind, "manual");
  assert.equal(byId["hemmings-1"].transmission, "Механика");
  assert.equal(byId["hemmings-2"].transmissionKind, "automatic");
  assert.equal(byId["hemmings-2"].transmission, "Автомат");
  assert.equal(byId["hemmings-3"].transmissionKind, undefined);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a deep backfill (stopWhenKnown: false) walks every page up to maxPages", async () => {
  const dataDir = tmpDir();
  const pages = [];
  const fullPage = from => Array.from({ length: 50 }, (_, i) => soldItem(from + i));
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async (url) => {
      const params = new URL(url).searchParams;
      if (params.get("transmission_type[]"))
        return { ok: true, json: async () => searchResponse([]) };
      const page = Number(params.get("page"));
      pages.push(page);
      return { ok: true, json: async () => searchResponse(fullPage(page * 100)) };
    },
    log: () => {},
  });

  assert.equal(await scraper.updateSoldArchive({ maxPages: 3, stopWhenKnown: false }), 150);
  assert.deepEqual(pages, [1, 2, 3]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() leaves the sold archive alone while a long enrichment job holds sold.lock", async () => {
  const dataDir = tmpDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "sold.lock"), "");
  let soldRequests = 0;
  const scraper = new HemmingsScraper({
    dataDir,
    fetchImpl: async (url) => {
      if (decodeURIComponent(url).includes("listing_status[]=sold"))
        soldRequests += 1;
      return { ok: true, json: async () => searchResponse([listing()]) };
    },
    log: () => {},
  });

  await scraper.run();
  assert.equal(soldRequests, 0);

  fs.rmSync(path.join(dataDir, "sold.lock"));
  await scraper.run();
  assert.ok(soldRequests > 0);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
