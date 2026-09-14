const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a new estimate of a sold lot keeps its auction result and manual prices', () => {
  const previous = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-append-'));
  process.chdir(dir);
  try {
    const history = require('../src/history/store');
    history.appendRun([{ lotNumber: 'A', maxBidUsd: 5000 }, { lotNumber: 'B', maxBidUsd: 7000 }]);
    history.setActual('A', { soldPriceUsd: 13225, soldAt: '2026-09-14', note: 'Final bid на bid.cars' });
    history.setMarketReference('A', { belarusPriceUsd: 21000 });

    history.appendRun([{ lotNumber: 'A', maxBidUsd: 7069 }, { lotNumber: 'B', maxBidUsd: 7100 }]);

    const [, , freshA, freshB] = history.readAll();
    assert.equal(freshA.actual.soldPriceUsd, 13225);
    assert.equal(freshA.marketReference.belarusPriceUsd, 21000);
    assert.equal(freshB.actual, null);

    const lotA = history.buildSummary().comparisons.find(item => item.lotNumber === 'A');
    assert.equal(lotA.maxBidUsd, 7069);
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
