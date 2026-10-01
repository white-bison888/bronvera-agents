const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CarsAndBidsScraper = require("../src/rare/carsandbids-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-rare-carsandbids-"));

const auction = (overrides = {}) => ({
  id: "3LadvLR0",
  title: "2008 Mercedes-Benz SLR McLaren Roadster",
  sub_title: "617-hp Supercharged V8, 8k Miles",
  mileage: "7,800 Miles",
  transmission: 1,
  current_bid: 248888,
  auction_end: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
  status: "live",
  main_photo: { base_url: "media.carsandbids.com", path: "abc/photo.jpg" },
  ...overrides,
});

// (offset) => auctions[] — одна общая страница на offset=0, пусто дальше (как настоящая пагинация при <52 лотах).
const fetchPageOf = auctions => async (offset) => (offset === 0 ? auctions : []);

const noClosed = async () => [];

test("run() maps an auction to a RareLot with mileage/transmission from the list response", async () => {
  const dataDir = tmpDir();
  const scraper = new CarsAndBidsScraper({ dataDir, fetchPage: fetchPageOf([auction()]), fetchClosedPage: noClosed, log: () => {} });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);

  const lot = lots[0];
  assert.equal(lot.id, "carsandbids-3LadvLR0");
  assert.equal(lot.source, "Cars & Bids");
  assert.equal(lot.sourceUrl, "https://carsandbids.com/auctions/3LadvLR0/2008-mercedes-benz-slr-mclaren-roadster");
  assert.equal(lot.make, "Mercedes-Benz");
  assert.equal(lot.model, "SLR McLaren"); // "Roadster" — стоп-слово кузова, та же логика, что и у BaT
  assert.equal(lot.mileage, 7800);
  assert.equal(lot.transmission, "Автомат");
  assert.equal(lot.currentBid, 248888); // уже в долларах, не в центах
  assert.equal(lot.photoUrl, "https://media.carsandbids.com/abc/photo.jpg");
  assert.equal(lot.status, "open");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() maps transmission code 2 to Механика", async () => {
  const dataDir = tmpDir();
  const scraper = new CarsAndBidsScraper({ dataDir, fetchPage: fetchPageOf([auction({ transmission: 2 })]), fetchClosedPage: noClosed, log: () => {} });

  const [lot] = await scraper.run();
  assert.equal(lot.transmission, "Механика");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() leaves transmission null for an unrecognised code rather than guessing", async () => {
  const dataDir = tmpDir();
  const scraper = new CarsAndBidsScraper({ dataDir, fetchPage: fetchPageOf([auction({ transmission: 9 })]), fetchClosedPage: noClosed, log: () => {} });

  const [lot] = await scraper.run();
  assert.equal(lot.transmission, null);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() marks a lot closing within 48h, and still closing (not ended) once scheduled auction_end has passed but the platform still calls it live", async () => {
  const dataDir = tmpDir();
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  const scraper = new CarsAndBidsScraper({
    dataDir,
    fetchPage: fetchPageOf([
      auction({ id: "closing", auction_end: soon }),
      auction({ id: "still-live", auction_end: past, status: "live" }),
    ]),
    fetchClosedPage: noClosed,
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.find(l => l.id === "carsandbids-closing").status, "closing");
  // Баг от Mikita 01.10 (тот же класс, что у BaT): Cars & Bids продлевает
  // торги при ставке в последние секунды и держит лот "live", пока не
  // подведёт итог — расписанное auction_end в прошлом само по себе не
  // значит, что торги закрылись. Проверено на двух настоящих лотах 01.10:
  // "ended" здесь показал бы ставку, которая ещё может вырасти.
  assert.equal(lots.find(l => l.id === "carsandbids-still-live").status, "closing");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() marks a lot ended once the platform itself says so, not just by time", async () => {
  const dataDir = tmpDir();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  const scraper = new CarsAndBidsScraper({
    dataDir,
    fetchPage: fetchPageOf([auction({ id: "settled", auction_end: past, status: "sold", sale_amount: 251000 })]),
    fetchClosedPage: noClosed,
    log: () => {},
  });

  const [lot] = await scraper.run();
  assert.equal(lot.status, "ended");
  assert.equal(lot.currentBid, 251000, "sale_amount — настоящая цена сделки (например, Buy It Now обходит current_bid совсем)");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("fetchAllAuctions walks pages by offset until a short page ends pagination", async () => {
  const calls = [];
  const scraper = new CarsAndBidsScraper({
    dataDir: tmpDir(),
    fetchPage: async (offset) => {
      calls.push(offset);
      if (offset === 0)
        return Array.from({ length: 52 }, (_, i) => auction({ id: `a${i}` }));
      if (offset === 52)
        return [auction({ id: "last" })]; // короче лимита — страница последняя
      return [];
    },
    log: () => {},
  });

  const items = await scraper.fetchAllAuctions();
  assert.deepEqual(calls, [0, 52]);
  assert.equal(items.length, 53);
});

test("run() reports only genuinely new lots to alerts.checkAfterRun", async () => {
  const dataDir = tmpDir();
  const calls = [];
  const alerts = { checkAfterRun: async (args) => { calls.push(args); } };

  const scraper = new CarsAndBidsScraper({ dataDir, alerts, fetchPage: fetchPageOf([auction({ id: "a1" })]), fetchClosedPage: noClosed, log: () => {} });

  await scraper.run();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].newLots.map(l => l.id), ["carsandbids-a1"]);

  scraper.fetchPage = fetchPageOf([auction({ id: "a1" }), auction({ id: "a2" })]);
  await scraper.run();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].newLots.map(l => l.id), ["carsandbids-a2"]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() writes a failed status and rethrows when fetching fails", async () => {
  const dataDir = tmpDir();
  const scraper = new CarsAndBidsScraper({
    dataDir,
    fetchPage: async () => { throw new Error("прокси недоступен"); },
    log: () => {},
  });

  await assert.rejects(() => scraper.run());
  const status = scraper.readStatus();
  assert.equal(status.ok, false);
  assert.match(status.error, /прокси/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

const closedAuction = (overrides = {}) => auction({
  id: "closed-1",
  status: "sold",
  current_bid: 32750,
  sale_amount: 32750,
  auction_end: "2026-10-01T18:00:00.000Z",
  ...overrides,
});

test("run() archives a sold lot from /past-auctions into the Stats sold archive", async () => {
  const dataDir = tmpDir();
  const scraper = new CarsAndBidsScraper({
    dataDir,
    fetchPage: fetchPageOf([]),
    fetchClosedPage: async () => [closedAuction()],
    log: () => {},
  });

  await scraper.run();
  const sold = scraper.readSold();
  assert.equal(sold.length, 1);
  assert.equal(sold[0].id, "carsandbids-closed-1");
  assert.equal(sold[0].salePrice, 32750);
  assert.equal(sold[0].sold, true);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() keeps a reserve-not-met result but marks it unsold, and drops canceled listings entirely", async () => {
  const dataDir = tmpDir();
  const scraper = new CarsAndBidsScraper({
    dataDir,
    fetchPage: fetchPageOf([]),
    fetchClosedPage: async () => [
      closedAuction({ id: "unsold-1", status: "reserve_not_met", sale_amount: null }),
      closedAuction({ id: "pulled-1", status: "canceled", sale_amount: null }),
    ],
    log: () => {},
  });

  await scraper.run();
  const sold = scraper.readSold();
  assert.equal(sold.length, 1, "canceled — не настоящий результат торгов, в архив не идёт");
  assert.equal(sold[0].id, "carsandbids-unsold-1");
  assert.equal(sold[0].sold, false);
  assert.equal(sold[0].salePrice, 32750, "sale_amount нет — используем current_bid");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() does not duplicate a lot already in the sold archive", async () => {
  const dataDir = tmpDir();
  const scraper = new CarsAndBidsScraper({
    dataDir,
    fetchPage: fetchPageOf([]),
    fetchClosedPage: async () => [closedAuction()],
    log: () => {},
  });

  await scraper.run();
  await scraper.run();

  assert.equal(scraper.readSold().length, 1);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
