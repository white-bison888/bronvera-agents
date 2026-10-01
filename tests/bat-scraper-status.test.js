const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BatScraper = require("../src/rare/bat-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-bat-"));

const htmlWithListings = items =>
  `<script id="bat-theme-auctions-current-initial-data">var auctionsCurrentInitialData = ${JSON.stringify({ items })}; /* ]]> */</script>`;

test("a successful run records ok status with the lot count", async () => {
  const dataDir = tmpDir();
  const items = [{
    id: 1,
    title: "1990 Mercedes-Benz 190E",
    active: true,
    timestamp_end: Math.floor(Date.now() / 1000) + 3600,
    current_bid: 1000,
    thumbnail_url: null,
    url: "https://bringatrailer.com/listing/1",
  }];
  const fetchImpl = async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings(items) };
    return { ok: true, text: async () => "<strong>Listing Details</strong><ul></ul>" };
  };

  const scraper = new BatScraper({ fetchImpl, dataDir, log: () => {} });
  await scraper.run();

  const status = scraper.readStatus();
  assert.equal(status.ok, true);
  assert.equal(status.count, 1);
  assert.equal(status.error, null);
  assert.ok(status.lastRunAt);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a failed run records the error, not a silent success", async () => {
  const dataDir = tmpDir();
  const fetchImpl = async () => ({ ok: false, status: 503 });

  const scraper = new BatScraper({ fetchImpl, dataDir, log: () => {} });
  await assert.rejects(() => scraper.run());

  const status = scraper.readStatus();
  assert.equal(status.ok, false);
  assert.equal(status.count, null);
  assert.match(status.error, /503/);
  assert.ok(status.lastRunAt);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a later failure overwrites an earlier success, not kept stale", async () => {
  const dataDir = tmpDir();
  const okFetch = async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings([]) };
    return { ok: true, text: async () => "" };
  };
  const failFetch = async () => ({ ok: false, status: 403 });

  const scraper = new BatScraper({ fetchImpl: okFetch, dataDir, log: () => {} });
  await scraper.run();
  assert.equal(scraper.readStatus().ok, true);

  scraper.fetchImpl = failFetch;
  await assert.rejects(() => scraper.run());
  assert.equal(scraper.readStatus().ok, false);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("before the first run, status is unknown rather than failed", () => {
  const dataDir = tmpDir();
  const scraper = new BatScraper({ dataDir });

  const status = scraper.readStatus();
  assert.equal(status.ok, null);
  assert.equal(status.lastRunAt, null);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
