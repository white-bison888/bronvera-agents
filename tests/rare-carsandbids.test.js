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

test("run() maps an auction to a RareLot with mileage/transmission from the list response", async () => {
  const dataDir = tmpDir();
  const scraper = new CarsAndBidsScraper({ dataDir, fetchPage: fetchPageOf([auction()]), log: () => {} });

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
  const scraper = new CarsAndBidsScraper({ dataDir, fetchPage: fetchPageOf([auction({ transmission: 2 })]), log: () => {} });

  const [lot] = await scraper.run();
  assert.equal(lot.transmission, "Механика");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() leaves transmission null for an unrecognised code rather than guessing", async () => {
  const dataDir = tmpDir();
  const scraper = new CarsAndBidsScraper({ dataDir, fetchPage: fetchPageOf([auction({ transmission: 9 })]), log: () => {} });

  const [lot] = await scraper.run();
  assert.equal(lot.transmission, null);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() marks a lot closing within 48h and ended once auction_end has passed", async () => {
  const dataDir = tmpDir();
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  const scraper = new CarsAndBidsScraper({
    dataDir,
    fetchPage: fetchPageOf([
      auction({ id: "closing", auction_end: soon }),
      auction({ id: "ended", auction_end: past }),
    ]),
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.find(l => l.id === "carsandbids-closing").status, "closing");
  assert.equal(lots.find(l => l.id === "carsandbids-ended").status, "ended");

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

  const scraper = new CarsAndBidsScraper({ dataDir, alerts, fetchPage: fetchPageOf([auction({ id: "a1" })]), log: () => {} });

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
