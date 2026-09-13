const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sold = { soldPriceUsd: 10000, soldAt: '2026-09-13T09:00:00.000Z', note: null };

test('a lot analysed several times counts once, by its latest estimate', () => {
  const previous = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-summary-'));
  process.chdir(dir);
  try {
    fs.mkdirSync('data');
    // Порядок в файле намеренно не совпадает с порядком по времени.
    fs.writeFileSync('data/recommendations-history.json', JSON.stringify([
      { lotNumber: 'A', createdAt: '2026-09-06T12:00:00.000Z', maxBidUsd: 2000, viable: true, repairCostSource: 'norm', actual: sold },
      { lotNumber: 'A', createdAt: '2026-09-07T12:00:00.000Z', maxBidUsd: 6000, viable: true, repairCostSource: 'photo', actual: sold },
      { lotNumber: 'A', createdAt: '2026-09-06T18:00:00.000Z', maxBidUsd: 2000, viable: true, repairCostSource: 'norm', actual: sold },
      { lotNumber: 'B', createdAt: '2026-09-06T12:00:00.000Z', maxBidUsd: 8000, viable: true, repairCostSource: 'norm', actual: sold },
      { lotNumber: 'C', createdAt: '2026-09-06T12:00:00.000Z', maxBidUsd: 5000, viable: true, actual: sold },
      { lotNumber: 'C', createdAt: '2026-09-07T12:00:00.000Z', maxBidUsd: 0, viable: false, actual: sold },
      { lotNumber: 'D', createdAt: '2026-09-07T12:00:00.000Z', maxBidUsd: 4000, viable: true, actual: null },
    ]));

    const summary = require('../src/history/store').buildSummary();

    assert.equal(summary.totalEntries, 7);
    assert.equal(summary.withActualPrice, 3);
    assert.equal(summary.comparisons.length, 3);
    assert.equal(summary.forecastCount, 2);
    assert.equal(summary.notViableCount, 1);

    const lotA = summary.comparisons.find(item => item.lotNumber === 'A');
    assert.equal(lotA.maxBidUsd, 6000);
    assert.equal(lotA.estimatesCount, 3);
    assert.equal(lotA.estimatedAt, '2026-09-07T12:00:00.000Z');

    // A −40%, B −20%: без схлопывания A утянул бы среднее к −47%.
    assert.equal(summary.averageBiasPct, -30);
    assert.equal(summary.averageDeviationPct, 30);
    assert.deepEqual(summary.byRepairSource.map(group => [group.key, group.count]), [['photo', 1], ['norm', 1]]);
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
