const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-positions-'));
process.env.FORECAST_POSITIONS_FILE = path.join(dir, 'positions.json');

const positions = require('../src/economics/forecast-positions');
const { calculateMaxBid } = require('../src/economics/max-bid');
const { expectedPriceUsd } = require('../src/screener/select');
const { recalculateOpenLots } = require('../src/economics/recalculate');

const year = new Date().getFullYear();
const photoAssessment = { available: true, repairCostMin: 2000, repairCostMax: 4000, photosAnalyzed: 12 };
const lot = { lotNumber: 'Y1', model: 'MODEL Y', year: year - 2, marketValueUsd: 30000, seller: 'State Farm Group Insurance', photoAssessment, auctionEstimateMin: 10000, auctionEstimateMax: 14000 };

test('an applied point moves the forecast of that model only, and undo brings the common point back', () => {
  assert.equal(calculateMaxBid(lot).forecast.expectedUsd, Math.round(10000 + 0.77 * 4000));

  const applied = positions.decide({ model: 'Model Y', choice: 'apply', position: 0.65, basis: { lots: 10 } });
  assert.equal(applied.from, 0.77);
  assert.equal(applied.to, 0.65);
  assert.equal(positions.positionFor('MODEL Y'), 0.65);

  const result = calculateMaxBid(lot);
  assert.equal(result.forecast.expectedUsd, Math.round(10000 + 0.65 * 4000));
  assert.equal(result.assumptions.forecastPosition, 0.65);
  assert.equal(calculateMaxBid({ ...lot, model: 'MODEL 3' }).forecast.position, 0.77);
  // Явно переданная точка важнее поправки.
  assert.equal(calculateMaxBid(lot, { forecastPosition: 0.9 }).forecast.position, 0.9);
  assert.equal(expectedPriceUsd(lot), Math.round(10000 + 0.65 * 4000));

  positions.decide({ model: 'Model Y', choice: 'wait' });
  assert.equal(positions.positionFor('MODEL Y'), 0.65);

  const undone = positions.decide({ model: 'Model Y', choice: 'undo' });
  assert.equal(undone.to, 0.77);
  assert.equal(positions.positionFor('MODEL Y'), null);
  assert.deepEqual(positions.list().decisions.map(d => d.choice), ['undo', 'wait', 'apply']);

  assert.throws(() => positions.decide({ model: 'Model Y', choice: 'undo' }));
  assert.throws(() => positions.decide({ model: 'Model Y', choice: 'apply', position: 7 }));
});

test('open lots of the model get a new estimate at the new point; sold and other models stay', () => {
  const now = Date.parse('2026-09-15T18:00:00Z');
  const appended = [];
  const entries = [
    { lotNumber: 'OPEN', model: 'MODEL Y', year: year - 2, marketValueUsd: 30000, decision: 'WATCH', createdAt: '2026-09-15T10:00:00Z', lotDetails: { seller: 'State Farm' } },
    { lotNumber: 'PAST', model: 'MODEL Y', year: year - 2, marketValueUsd: 30000, decision: 'SKIP', createdAt: '2026-09-14T10:00:00Z' },
    { lotNumber: 'OTHER', model: 'MODEL 3', year: year - 2, marketValueUsd: 25000, decision: 'BUY', createdAt: '2026-09-15T10:00:00Z' },
  ];
  const registry = {
    OPEN: { lotNumber: 'OPEN', model: 'MODEL Y', year: year - 2, saleDate: '2026-09-16T14:00:00Z', auctionEstimateMin: 10000, auctionEstimateMax: 14000, currentBid: 5000 },
    PAST: { lotNumber: 'PAST', model: 'MODEL Y', year: year - 2, saleDate: '2026-09-15T14:00:00Z', auctionEstimateMin: 10000, auctionEstimateMax: 14000 },
    OTHER: { lotNumber: 'OTHER', model: 'MODEL 3', year: year - 2, saleDate: '2026-09-16T14:00:00Z', auctionEstimateMin: 8000, auctionEstimateMax: 11000 },
  };

  positions.decide({ model: 'Model Y', choice: 'apply', position: 0.65 });
  const recalculated = recalculateOpenLots({
    model: 'Model Y',
    now,
    bidCars: { findByLotNumber: number => registry[number] },
    photoAssessor: { getCached: () => photoAssessment },
    history: { readAll: () => entries, appendRun: records => appended.push(...records) },
  });

  assert.deepEqual(recalculated, ['OPEN']);
  assert.equal(appended[0].forecast.position, 0.65);
  assert.equal(appended[0].forecast.expectedUsd, Math.round(10000 + 0.65 * 4000));
  assert.equal(appended[0].recalculatedFor, 'forecast-position');
  assert.equal(appended[0].lotDetails.seller, 'State Farm');
  positions.decide({ model: 'Model Y', choice: 'undo' });
});

test('a recalculation takes the last known Belarus price, not the last record', () => {
  const now = Date.parse('2026-09-20T06:00:00Z');
  const appended = [];
  // Вторая запись без цены — так бывает после ручного пересчёта; лот не должен её терять.
  const entries = [
    { lotNumber: 'OPEN', model: 'MODEL Y', year: year - 2, marketValueUsd: 30000, decision: 'WATCH', createdAt: '2026-09-19T10:00:00Z', lotDetails: { seller: 'State Farm Group Insurance' } },
    { lotNumber: 'OPEN', model: 'MODEL Y', year: year - 2, marketValueUsd: null, decision: 'NEEDS_MARKET_DATA', createdAt: '2026-09-19T20:00:00Z' },
  ];

  const recalculated = recalculateOpenLots({
    model: 'Model Y',
    now,
    bidCars: { findByLotNumber: () => ({ lotNumber: 'OPEN', model: 'MODEL Y', year: year - 2, saleDate: '2026-09-22T14:00:00Z', auctionEstimateMin: 10000, auctionEstimateMax: 14000, seller: 'State Farm Group Insurance' }) },
    photoAssessor: { getCached: () => photoAssessment },
    history: { readAll: () => entries, appendRun: records => appended.push(...records) },
  });

  assert.deepEqual(recalculated, ['OPEN']);
  assert.equal(appended[0].marketValueUsd, 30000);
  assert.equal(appended[0].decision, 'BUY');
});
