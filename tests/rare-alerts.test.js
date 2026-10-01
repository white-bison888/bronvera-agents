const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RareAlerts = require("../src/rare/alerts");
const BatScraper = require("../src/rare/bat-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-rare-alerts-"));

const lot = (overrides = {}) => ({
  id: "bat-1",
  title: "1991 BMW M3 (E30)",
  make: "BMW",
  model: "M3",
  sourceUrl: "https://bringatrailer.com/listing/1",
  currentBid: 20000,
  status: "open",
  ...overrides,
});

test("matchesKeyword requires every word, from make/model/title combined", () => {
  const alerts = new RareAlerts({ dataDir: tmpDir() });
  assert.equal(alerts.matchesKeyword(lot(), "e30 m3"), true);
  assert.equal(alerts.matchesKeyword(lot(), "e36"), false);
  assert.equal(alerts.matchesKeyword(lot({ title: "1985 BMW 325e Coupe", model: "325e" }), "e30 m3"), false);
});

test("watchlist items persist across reads and can be removed", () => {
  const dataDir = tmpDir();
  const alerts = new RareAlerts({ dataDir });

  const item = alerts.addWatchlistItem({ keyword: "e30 m3", budgetMax: "30000" });
  assert.equal(item.keyword, "e30 m3");
  assert.equal(item.budgetMax, 30000);
  assert.equal(alerts.readWatchlist().length, 1);

  alerts.removeWatchlistItem(item.id);
  assert.equal(alerts.readWatchlist().length, 0);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("addWatchlistItem refuses an empty keyword", () => {
  const alerts = new RareAlerts({ dataDir: tmpDir() });
  assert.throws(() => alerts.addWatchlistItem({ keyword: "   " }));
});

test("setLotWatch adds and removes a lot, seeding known bid/status", () => {
  const dataDir = tmpDir();
  const alerts = new RareAlerts({ dataDir });

  alerts.setLotWatch("bat-1", true, lot());
  const watched = alerts.readWatchedLots();
  assert.equal(watched["bat-1"].lastBid, 20000);
  assert.equal(watched["bat-1"].lastStatus, "open");

  alerts.setLotWatch("bat-1", false);
  assert.equal(Object.keys(alerts.readWatchedLots()).length, 0);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("checkAfterRun alerts on a new lot matching a saved criterion, not on an already-seen one", async () => {
  const dataDir = tmpDir();
  const sent = [];
  const alerts = new RareAlerts({ dataDir, send: async (text) => { sent.push(text); return true; } });
  alerts.addWatchlistItem({ keyword: "e30 m3" });

  const newLot = lot({ id: "bat-new" });
  const oldLot = lot({ id: "bat-old" });

  await alerts.checkAfterRun({
    newLots: [newLot],
    allLotsById: new Map([["bat-new", newLot], ["bat-old", oldLot]]),
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /e30 m3/);
  assert.match(sent[0], /M3/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("checkAfterRun skips a match over budget", async () => {
  const dataDir = tmpDir();
  const sent = [];
  const alerts = new RareAlerts({ dataDir, send: async (text) => { sent.push(text); return true; } });
  alerts.addWatchlistItem({ keyword: "m3", budgetMax: 10000 });

  const expensive = lot({ id: "bat-new", currentBid: 50000 });

  await alerts.checkAfterRun({ newLots: [expensive], allLotsById: new Map([["bat-new", expensive]]) });

  assert.equal(sent.length, 0);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("checkAfterRun alerts a watched lot on bid change and on status change, then remembers the new values", async () => {
  const dataDir = tmpDir();
  const sent = [];
  const alerts = new RareAlerts({ dataDir, send: async (text) => { sent.push(text); return true; } });
  alerts.setLotWatch("bat-1", true, lot({ currentBid: 20000, status: "open" }));

  const updated = lot({ currentBid: 22000, status: "closing" });
  await alerts.checkAfterRun({ newLots: [], allLotsById: new Map([["bat-1", updated]]) });

  assert.equal(sent.length, 2);
  assert.match(sent[0], /22.000/); // "22 000" — неразрывный пробел от toLocaleString
  assert.match(sent[1], /скоро закрываются/);

  const stored = alerts.readWatchedLots()["bat-1"];
  assert.equal(stored.lastBid, 22000);
  assert.equal(stored.lastStatus, "closing");

  // Второй прогон без изменений — новых сообщений нет.
  sent.length = 0;
  await alerts.checkAfterRun({ newLots: [], allLotsById: new Map([["bat-1", updated]]) });
  assert.equal(sent.length, 0);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("checkAfterRun ignores a watched lot that fell out of the current list", async () => {
  const dataDir = tmpDir();
  const sent = [];
  const alerts = new RareAlerts({ dataDir, send: async (text) => { sent.push(text); return true; } });
  alerts.setLotWatch("bat-1", true, lot());

  await assert.doesNotReject(() => alerts.checkAfterRun({ newLots: [], allLotsById: new Map() }));
  assert.equal(sent.length, 0);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("sendTelegramMessage logs and no-ops when the bot is not configured", async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  const dataDir = tmpDir();
  const alerts = new RareAlerts({ dataDir, log: () => {} }); // send по умолчанию -> sendTelegramMessage
  alerts.addWatchlistItem({ keyword: "m3" });

  const newLot = lot({ id: "bat-new" });
  await assert.doesNotReject(() => alerts.checkAfterRun({ newLots: [newLot], allLotsById: new Map([["bat-new", newLot]]) }));

  if (originalToken)
    process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChatId)
    process.env.TELEGRAM_CHAT_ID = originalChatId;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- интеграция с BatScraper: новые лоты определяются по сравнению с прошлым прогоном ---

const htmlWithListings = items =>
  `<script id="bat-theme-auctions-current-initial-data">var auctionsCurrentInitialData = ${JSON.stringify({ items })}; /* ]]> */</script>`;

const batItem = (id, overrides = {}) => ({
  id,
  title: "1991 BMW M3 (E30)",
  active: true,
  timestamp_end: Math.floor(Date.now() / 1000) + 3600,
  current_bid: 20000,
  thumbnail_url: null,
  url: `https://bringatrailer.com/listing/${id}`,
  ...overrides,
});

test("BatScraper.run() only reports lots that are new since the previous run to alerts.checkAfterRun", async () => {
  const dataDir = tmpDir();
  const calls = [];
  const alerts = { checkAfterRun: async (args) => { calls.push(args); } };

  const fetchImpl = itemsRef => async (url) => {
    if (String(url).includes("/auctions/"))
      return { ok: true, text: async () => htmlWithListings(itemsRef.items) };
    return { ok: true, text: async () => "<strong>Listing Details</strong><ul></ul>" };
  };

  const itemsRef = { items: [batItem(1)] };
  const scraper = new BatScraper({ fetchImpl: fetchImpl(itemsRef), dataDir, log: () => {}, alerts });
  await scraper.run();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].newLots.map(l => l.id), ["bat-1"]);

  // Второй прогон: тот же лот плюс один новый — алертится только новый.
  itemsRef.items = [batItem(1), batItem(2)];
  await scraper.run();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].newLots.map(l => l.id), ["bat-2"]);
  assert.equal(calls[1].allLotsById.size, 2);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
