const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMarketReference } = require('../src/history/market-reference');

test('source requires a safe URL and a real observation date', () => {
  const reference = normalizeMarketReference({ polandPriceUsd: '20000', polandSourceUrl: 'https://example.com/car', polandObservedOn: '2026-09-07' });
  assert.equal(reference.polandPriceUsd, 20000);
  assert.equal(reference.polandSourceUrl, 'https://example.com/car');
  for (const source of ['javascript:alert(1)', 'https://user:password@example.com', 'invalid'])
    assert.throws(() => normalizeMarketReference({ polandSourceUrl: source, polandObservedOn: '2026-09-07' }));
  assert.throws(() => normalizeMarketReference({ polandSourceUrl: 'https://example.com', polandObservedOn: '2026-02-30' }));
  assert.throws(() => normalizeMarketReference({ polandPriceUsd: -1 }));
});

test('price changes cannot silently inherit old evidence', () => {
  const previous = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-reference-'));
  process.chdir(dir);
  try {
    const history = require('../src/history/store');
    history.appendRun([{ lotNumber: '123' }]);
    history.setMarketReference('123', normalizeMarketReference({ polandPriceUsd: 20000, polandSourceUrl: 'https://example.com/car', polandObservedOn: '2026-09-07' }));
    assert.equal(history.readAll()[0].marketReference.polandObservedOn, '2026-09-07');
    history.setMarketReference('123', { belarusPriceUsd: 18000 });
    assert.equal(history.readAll()[0].marketReference.polandSourceUrl, 'https://example.com/car');
    history.setMarketReference('123', { polandPriceUsd: 22000 });
    assert.equal(history.readAll()[0].marketReference.polandSourceUrl, null);
    assert.equal(history.readAll()[0].marketReference.polandObservedOn, null);
  } finally { process.chdir(previous); fs.rmSync(dir, { recursive: true, force: true }); }
});
