const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BatScraper = require("../src/rare/bat-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-bat-price-"));

const htmlWithListings = items =>
  `<script id="bat-theme-auctions-current-initial-data">var auctionsCurrentInitialData = ${JSON.stringify({ items })}; /* ]]> */</script>`;

const auctionResultHtml = (label, price) =>
  `<span class="info-value noborder-tiny">${label} <strong>USD $${price}</strong> <span class="date date-localize" data-timestamp="1" data-format="L">on 10/1/26</span></span>`;

const endedItem = (overrides = {}) => ({
  id: 42,
  title: "2006 Ford GT Heritage Edition",
  active: false,
  current_bid: 1026000, // устаревший снимок с индекса — см. баг от Mikita 01.10
  thumbnail_url: null,
  url: "https://bringatrailer.com/listing/2006-ford-gt-227/",
  ...overrides,
});

test("an ended lot's final price overrides the stale index snapshot", async () => {
  const dataDir = tmpDir();
  const now = Date.now();
  const items = [endedItem({ timestamp_end: Math.floor((now - 3600_000) / 1000) })];
  const detailHtml = auctionResultHtml("Sold for", "1,261,000");

  const fetchImpl = async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings(items) };
    return { ok: true, text: async () => detailHtml };
  };

  const scraper = new BatScraper({ fetchImpl, dataDir, now: () => now, log: () => {} });
  const lots = await scraper.run();

  assert.equal(lots[0].status, "ended");
  assert.equal(lots[0].currentBid, 1261000);
  assert.equal(lots[0].sold, true);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a lot cached while open gets its final price backfilled once it closes", async () => {
  const dataDir = tmpDir();
  const now = Date.now();

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "lot-details.json"),
    // Старый кэш (до этого фикса) — уже есть пробег/коробка, finalPrice ещё нет.
    JSON.stringify({ "bat-42": { vin: null, mileage: 3000, transmission: "6-ступенчатая механика", ownerType: null } }),
  );

  const items = [endedItem({ timestamp_end: Math.floor((now - 60_000) / 1000) })];
  const detailHtml = auctionResultHtml("Sold for", "1,261,000");

  let detailFetches = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings(items) };
    detailFetches += 1;
    return { ok: true, text: async () => detailHtml };
  };

  const scraper = new BatScraper({ fetchImpl, dataDir, now: () => now, log: () => {} });
  const lots = await scraper.run();

  assert.equal(detailFetches, 1);
  assert.equal(lots[0].currentBid, 1261000);
  assert.equal(lots[0].mileage, 3000, "старые поля из кэша не теряются");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("an already-resolved ended lot is not fetched again", async () => {
  const dataDir = tmpDir();
  const now = Date.now();
  const items = [endedItem({ id: 9, timestamp_end: Math.floor((now - 60_000) / 1000), url: "https://bringatrailer.com/listing/2015-ferrari-458/" })];
  const detailHtml = auctionResultHtml("Sold for", "965,000");

  let detailFetches = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings(items) };
    detailFetches += 1;
    return { ok: true, text: async () => detailHtml };
  };

  const scraper = new BatScraper({ fetchImpl, dataDir, now: () => now, log: () => {} });
  await scraper.run();
  assert.equal(detailFetches, 1);

  await scraper.run(); // тот же закрытый лот ещё раз — цена уже известна
  assert.equal(detailFetches, 1, "уже закрытый лот с известной ценой не перезапрашиваем");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("reserve not met still captures the final high bid and marks it unsold", async () => {
  const dataDir = tmpDir();
  const now = Date.now();
  const items = [endedItem({
    id: 11,
    timestamp_end: Math.floor((now - 60_000) / 1000),
    url: "https://bringatrailer.com/listing/1998-porsche-911/",
  })];
  const detailHtml = auctionResultHtml("Bid to", "240,000");

  const fetchImpl = async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings(items) };
    return { ok: true, text: async () => detailHtml };
  };

  const scraper = new BatScraper({ fetchImpl, dataDir, now: () => now, log: () => {} });
  const lots = await scraper.run();

  assert.equal(lots[0].currentBid, 240000);
  assert.equal(lots[0].sold, false);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("an open lot keeps the index bid — no result page to read yet", async () => {
  const dataDir = tmpDir();
  const now = Date.now();
  const items = [{
    id: 5,
    title: "2019 Porsche 911 Speedster",
    active: true,
    timestamp_end: Math.floor((now + 72 * 3600_000) / 1000), // дальше, чем 48ч "closing soon"
    current_bid: 365000,
    thumbnail_url: null,
    url: "https://bringatrailer.com/listing/2019-porsche-911-speedster/",
  }];

  const fetchImpl = async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings(items) };
    return { ok: true, text: async () => "<strong>Listing Details</strong><ul></ul>" };
  };

  const scraper = new BatScraper({ fetchImpl, dataDir, now: () => now, log: () => {} });
  const lots = await scraper.run();

  assert.equal(lots[0].status, "open");
  assert.equal(lots[0].currentBid, 365000);
  assert.equal(lots[0].finalPrice, undefined, "рано фиксировать «результата нет» — лот ещё не закрылся, его разберут снова, когда закроется");

  fs.rmSync(dataDir, { recursive: true, force: true });
});
