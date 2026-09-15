const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MarketChecker, MAX_CHECKS } = require('../src/market/market-checks');

const DAY = 24 * 60 * 60 * 1000;
const start = Date.parse('2026-09-15T06:52:00Z');

const setup = ({ entries, prices }) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-checks-')), 'checks.json');
  const clock = { now: start };
  const calls = [];
  const checker = new MarketChecker({
    file,
    history: { readAll: () => entries },
    bidCars: { findByLotNumber: lot => ({ lotNumber: lot, mileage: 74073 }) },
    marketPrices: {
      async lookup(vehicle) {
        calls.push(vehicle);
        return prices.shift();
      },
    },
    now: () => clock.now,
    sleep: async () => {},
  });
  return { checker, clock, calls };
};

const ok = value => ({ status: 'ok', marketValueUsd: value, analogsCount: 12, fetchedAt: new Date().toISOString(), listings: [{ source: 'auto.kufar.by', url: 'https://auto.kufar.by/vi/1', priceUsd: value }] });

test('the Belarus price is checked 7 days after the forecast and weekly after that, four times at most', async () => {
  const entries = [
    { lotNumber: 'A', createdAt: '2026-09-15T06:52:48Z', make: 'Tesla', model: 'MODEL 3', year: 2023, marketValueUsd: 20450, market: { fetchedAt: '2026-09-15T06:52:38Z' } },
    // Пересчёт после фото с той же ценой — тот же прогноз.
    { lotNumber: 'A', createdAt: '2026-09-15T13:03:10Z', make: 'Tesla', model: 'MODEL 3', year: 2023, marketValueUsd: 20450, market: { fetchedAt: '2026-09-15T06:52:38Z' } },
  ];
  const { checker, clock, calls } = setup({ entries, prices: [ok(21000), { status: 'source_error' }, ok(19800), ok(20000), ok(20450), ok(22000)] });

  // Ещё ни одной сверки, а дата первой уже известна.
  assert.equal(checker.summary().A.nextAt, '2026-09-22T06:52:38.000Z');

  clock.now = start + 6 * DAY;
  assert.deepEqual(await checker.runDue(), []);

  clock.now = start + 7 * DAY + 60000;
  assert.deepEqual(await checker.runDue(), ['A']);
  assert.equal(calls[0].mileage, 74073);

  let lot = checker.summary().A;
  assert.equal(lot.forecastValueUsd, 20450);
  assert.equal(lot.checks[0].marketValueUsd, 21000);
  assert.equal(lot.checks[0].diffUsd, 550);
  assert.equal(lot.checks[0].diffPct, 2.7);
  assert.equal(lot.checks[0].analogsCount, 12);
  assert.equal('market' in lot.checks[0], false);
  assert.equal(checker.detail('A').checks[0].market.listings.length, 1);

  // Площадка не ответила — сверка не записана и повторится.
  clock.now = start + 14 * DAY + 60000;
  assert.deepEqual(await checker.runDue(), []);
  assert.deepEqual(await checker.runDue(), ['A']);

  for (let week = 3; week <= 5; week++) {
    clock.now = start + week * 7 * DAY + 120000;
    await checker.runDue();
  }

  lot = checker.summary().A;
  assert.equal(lot.checks.length, MAX_CHECKS);
  assert.equal(lot.nextAt, null);
});

test('a new Belarus price starts a new forecast and keeps the old checks in the archive', async () => {
  const entries = [
    { lotNumber: 'B', createdAt: '2026-09-08T10:00:00Z', make: 'Tesla', model: 'MODEL Y', year: 2024, marketValueUsd: 29800 },
  ];
  const { checker, clock } = setup({ entries, prices: [ok(30500)] });

  clock.now = Date.parse('2026-09-15T10:00:00Z');
  assert.deepEqual(await checker.runDue(), ['B']);

  entries.push({ lotNumber: 'B', createdAt: '2026-09-15T12:00:00Z', make: 'Tesla', model: 'MODEL Y', year: 2024, marketValueUsd: 28950 });
  clock.now = Date.parse('2026-09-16T10:00:00Z');
  assert.deepEqual(await checker.runDue(), []);

  const detail = checker.detail('B');
  assert.equal(detail.forecastValueUsd, 28950);
  assert.equal(detail.checks.length, 0);
  assert.equal(detail.archived[0].checks[0].marketValueUsd, 30500);
  assert.equal(detail.nextAt, '2026-09-22T12:00:00.000Z');
});
