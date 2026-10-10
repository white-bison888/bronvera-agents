const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalCwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-deep-'));
process.chdir(temp);

const BidCarsProvider = require('../src/providers/bidcars');

after(() => { process.chdir(originalCwd); fs.rmSync(temp, { recursive: true, force: true }); });

const provider = (extra = {}) => new BidCarsProvider({ cacheFile: path.join(temp, 'cache.json'), deepSearchPauseMs: [0, 0], ...extra });

test('slices split by auction first, then by years of a short range', () => {
  const slices = provider().deepSearchSlices({ auctionTypes: [], models: ['Raptor'], yearFrom: 2021, yearTo: 2023 });
  assert.deepEqual(slices.slice(0, 2), [{ auctionTypes: ['Copart'] }, { auctionTypes: ['IAAI'] }]);
  assert.deepEqual(slices.slice(2), [{ yearFrom: 2021, yearTo: 2021 }, { yearFrom: 2022, yearTo: 2022 }]);
  assert.equal(slices.length, 4);
});

test('an already narrowed auction is not split again, a long year range is not split by year', () => {
  const slices = provider().deepSearchSlices({ auctionTypes: ['Copart'], models: [], yearFrom: 2010, yearTo: 2024 });
  assert.deepEqual(slices, []);
});

test('deep search runs only when the first result hit the 50-lot ceiling, and merges new lots', async () => {
  const p = provider();
  const seen = [];
  p.refreshSource = async ({ filters }) => {
    seen.push(filters.auctionTypes?.[0] || filters.yearFrom);
    const id = `L${seen.length}`;
    return { listings: [{ lotNumber: id, vin: `V${id}`, make: 'Ford', model: 'F-150' }], httpStatus: 200, pagesFetched: 1, lastPageFetched: 1 };
  };
  const bucket = p.getBucket({ buckets: {} }, 'make:ford');

  assert.equal(await p.refreshDeepSlices({ bucketKey: 'make:ford', filters: { auctionTypes: [], models: [], yearFrom: null, yearTo: null }, bucket, firstCount: 12 }), 0);
  assert.deepEqual(seen, []);

  const added = await p.refreshDeepSlices({ bucketKey: 'make:ford', filters: { auctionTypes: [], models: [], yearFrom: null, yearTo: null }, bucket, firstCount: 50 });
  assert.deepEqual(seen, ['Copart', 'IAAI']);
  assert.equal(added, 2);
});

test('a refusal from the site stops the extra requests', async () => {
  const p = provider();
  let calls = 0;
  p.refreshSource = async () => {
    calls += 1;
    return { listings: [], partialRefresh: true, partialHttpStatus: 403 };
  };
  const bucket = p.getBucket({ buckets: {} }, 'make:ford');
  await p.refreshDeepSlices({ bucketKey: 'make:ford', filters: { auctionTypes: [], models: [] }, bucket, firstCount: 50 });
  assert.equal(calls, 1);
});
