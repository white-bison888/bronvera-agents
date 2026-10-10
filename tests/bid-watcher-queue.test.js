const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalCwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-watcher-'));
process.chdir(temp);

const history = require('../src/history/store');
const BidWatcher = require('../src/photos/bid-watcher');

after(() => { process.chdir(originalCwd); fs.rmSync(temp, { recursive: true, force: true }); });

const inHours = hours => new Date(Date.now() + hours * 3600000).toISOString();

test('a lot the site refused is rested, so the queue reaches the others', () => {
  history.appendRun(['A', 'B', 'C', 'D'].map(lotNumber => ({ lotNumber, saleDate: inHours(5) })));

  const listings = {
    // А — самый близкий к торгам, но площадка его не открывает: попытка была только что.
    A: { saleDate: inHours(2), url: 'u/A', bidAttemptAt: new Date(Date.now() - 5 * 60000).toISOString() },
    B: { saleDate: inHours(3), url: 'u/B' },
    C: { saleDate: inHours(4), url: 'u/C' },
    // Д — неудача была давно, снова годится.
    D: { saleDate: inHours(5), url: 'u/D', bidAttemptAt: new Date(Date.now() - 3 * 3600000).toISOString() },
  };

  const watcher = new BidWatcher({ bidCars: { findByLotNumber: lot => listings[lot] } });

  assert.deepEqual(watcher.pickLots().map(item => item.lot), ['B', 'C', 'D']);
});
