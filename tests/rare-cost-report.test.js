const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildRareCostSummary } = require("../src/rare/cost-report");

const DAY_MS = 86400000;
// Полдень по Минску (UTC+3) — подальше от полуночи, чтобы округление суток не задевало тест.
const atMinskNoon = daysAgo => new Date(Date.UTC(2026, 9, 1, 9, 0, 0) - daysAgo * DAY_MS).toISOString();
const NOW = Date.parse(atMinskNoon(0));

const SOURCE_IDS = ["bat", "pcarmarket", "rm-sothebys", "cars-and-bids", "hemmings"];

const entry = (overrides = {}) => ({
  kind: "proxy",
  source: "выдача PCARMARKET",
  bytes: 1000,
  costUsd: 0.001,
  at: atMinskNoon(0),
  ...overrides,
});

test("sources without a proxy ledger entry show an honest $0, not a missing row", () => {
  const summary = buildRareCostSummary({ sourceIds: SOURCE_IDS, entries: [], now: NOW });

  assert.equal(summary.today.totalUsd, 0);
  assert.deepEqual(summary.today.bySource.map(s => s.id), SOURCE_IDS);
  assert.ok(summary.today.bySource.every(s => s.costUsd === 0));
});

test("today only counts entries from today, by Minsk day boundary", () => {
  const entries = [
    entry({ costUsd: 0.002, at: atMinskNoon(0) }), // сегодня
    entry({ costUsd: 0.005, at: atMinskNoon(1) }), // вчера
  ];

  const summary = buildRareCostSummary({ sourceIds: SOURCE_IDS, entries, now: NOW });

  assert.equal(summary.today.totalUsd, 0.002);
  assert.equal(summary.today.bySource.find(s => s.id === "pcarmarket").costUsd, 0.002);
});

test("entries are attributed to the right source by their ledger label", () => {
  const entries = [
    entry({ source: "выдача PCARMARKET", costUsd: 0.001 }),
    entry({ source: "выдача Cars & Bids", costUsd: 0.004 }),
  ];

  const summary = buildRareCostSummary({ sourceIds: SOURCE_IDS, entries, now: NOW });

  assert.equal(summary.today.bySource.find(s => s.id === "pcarmarket").costUsd, 0.001);
  assert.equal(summary.today.bySource.find(s => s.id === "cars-and-bids").costUsd, 0.004);
  assert.equal(summary.today.totalUsd, 0.005);
});

test("entries from unrelated ledger sources (bid-watcher, screener) are ignored", () => {
  const entries = [
    entry({ source: "выдача PCARMARKET", costUsd: 0.001 }),
    entry({ source: "слежение за ставками", costUsd: 5 }),
    entry({ source: "выдача bid.cars", costUsd: 5 }),
    { kind: "vision", costUsd: 5, at: atMinskNoon(0) },
  ];

  const summary = buildRareCostSummary({ sourceIds: SOURCE_IDS, entries, now: NOW });
  assert.equal(summary.today.totalUsd, 0.001);
});

test("last7Days and last30Days sum the right trailing window, excluding what falls outside it", () => {
  const entries = [
    entry({ costUsd: 0.001, at: atMinskNoon(0) }),
    entry({ costUsd: 0.002, at: atMinskNoon(6) }), // внутри 7 дней
    entry({ costUsd: 0.003, at: atMinskNoon(8) }), // уже вне 7 дней, но внутри 30
    entry({ costUsd: 0.004, at: atMinskNoon(29) }), // внутри 30 дней
    entry({ costUsd: 0.005, at: atMinskNoon(31) }), // уже вне 30 дней
  ];

  const summary = buildRareCostSummary({ sourceIds: SOURCE_IDS, entries, now: NOW });

  assert.equal(summary.last7Days.totalUsd, 0.003); // 0.001 + 0.002
  assert.equal(summary.last30Days.totalUsd, 0.01); // всё кроме дня 31
});

test("daily returns exactly 30 consecutive days ending today, oldest first", () => {
  const summary = buildRareCostSummary({ sourceIds: SOURCE_IDS, entries: [], now: NOW });

  assert.equal(summary.daily.length, 30);
  assert.equal(summary.daily[29].date, summary.today.date);
  assert.equal(summary.daily[0].date, atMinskNoon(29).slice(0, 10));
});

test("a day with no entries appears in daily with zero, not skipped", () => {
  const entries = [entry({ costUsd: 0.001, at: atMinskNoon(0) })];
  const summary = buildRareCostSummary({ sourceIds: SOURCE_IDS, entries, now: NOW });

  const yesterday = summary.daily[28];
  assert.equal(yesterday.totalUsd, 0);
  assert.ok(yesterday.bySource.every(s => s.costUsd === 0));
});
