const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BatScraper = require("../src/rare/bat-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-bat-sold-"));

const htmlWithListings = items =>
  `<script id="bat-theme-auctions-current-initial-data">var auctionsCurrentInitialData = ${JSON.stringify({ items })}; /* ]]> */</script>`;

const auctionResultHtml = (label, price) =>
  `<strong>Listing Details</strong><ul><li>3,000 Miles</li></ul><span class="info-value noborder-tiny">${label} <strong>USD $${price}</strong> <span class="date date-localize" data-timestamp="1" data-format="L">on 10/1/26</span></span>`;

const endedItem = (overrides = {}) => ({
  id: 42,
  title: "2006 Ford GT Heritage Edition",
  active: false,
  current_bid: 1026000,
  thumbnail_url: null,
  url: "https://bringatrailer.com/listing/2006-ford-gt-227/",
  ...overrides,
});

test("run() archives a resolved ended lot into the Stats sold archive", async () => {
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
  await scraper.run();

  const sold = scraper.readSold();
  assert.equal(sold.length, 1);
  assert.equal(sold[0].id, "bat-42");
  assert.equal(sold[0].salePrice, 1261000);
  assert.equal(sold[0].sold, true);
  assert.equal(sold[0].year, 2006);
  assert.equal(sold[0].mileage, 3000);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() does not archive a lot whose result is still unresolved", async () => {
  const dataDir = tmpDir();
  const now = Date.now();
  const items = [endedItem({ timestamp_end: Math.floor((now - 60_000) / 1000) })];
  // Продление торгов — страница ещё не публикует Sold for/Bid to.
  const stillRunningHtml = "<strong class=\"info-value noborder-tiny\"><span class=\"listing-available-countdown\"></span></strong>";

  const fetchImpl = async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings(items) };
    return { ok: true, text: async () => stillRunningHtml };
  };

  const scraper = new BatScraper({ fetchImpl, dataDir, now: () => now, log: () => {} });
  await scraper.run();

  assert.equal(scraper.readSold().length, 0, "sold: null — ещё не знаем исход, рано архивировать");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() does not duplicate a lot already in the sold archive", async () => {
  const dataDir = tmpDir();
  const now = Date.now();
  const items = [endedItem({ timestamp_end: Math.floor((now - 3600_000) / 1000) })];
  const detailHtml = auctionResultHtml("Bid to", "900,000");

  const fetchImpl = async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings(items) };
    return { ok: true, text: async () => detailHtml };
  };

  const scraper = new BatScraper({ fetchImpl, dataDir, now: () => now, log: () => {} });
  await scraper.run();
  await scraper.run();

  const sold = scraper.readSold();
  assert.equal(sold.length, 1);
  assert.equal(sold[0].sold, false, "Bid to — резерв не достигнут, не продан");

  fs.rmSync(dataDir, { recursive: true, force: true });
});
