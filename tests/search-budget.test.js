const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalCwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-search-budget-'));
process.chdir(temp);
process.env.FORECAST_POSITIONS_FILE = path.join(temp, 'positions.json');

const BidCarsProvider = require('../src/providers/bidcars');
const { cheapestPromising } = require('../src/searches/budget-fallback');

after(() => { process.chdir(originalCwd); fs.rmSync(temp, { recursive: true, force: true }); });

const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString();
const year = new Date().getFullYear();

const car = (lotNumber, trim, min, max, extra = {}) => ({
  lotNumber, make: 'Tesla', model: 'Model S', year: year - 7, trim, mileage: 60000,
  auctionEstimateMin: min, auctionEstimateMax: max, runAndDrive: 'Run and Drive',
  seller: 'State Farm Group Insurance', saleDate: inTwoDays, primaryDamage: 'Front end', vehicleType: 'car', ...extra,
});

const registry = [
  car('A', '2019 Tesla Model S, 100D/Long Range/...', 12020, 17870),
  car('B', '2017 Tesla Model S, 100D/60D/75D/90D...', 7170, 11850),
  car('C', '2015 Tesla Model S, 70D/85D/P85D', 2900, 5600),
  car('D', '2018 Tesla MODEL S', 5000, 8000),
  car('E', 'P100D', 20000, 26000),
];

const provider = () => {
  const bidCars = new BidCarsProvider();
  bidCars.saveCache({ version: 3, buckets: { 'make:tesla': { bucketKey: 'make:tesla', vehicles: registry } } });
  return bidCars;
};

test('trims keep possible matches and count lots without trim data', () => {
  const bidCars = provider();
  const found = bidCars.localMatches({ make: 'Tesla', models: ['Model S'], trims: ['100D'] });

  assert.deepEqual(found.map(item => item.lotNumber).sort(), ['A', 'B']);
  assert.ok(found.every(item => item.trimStatus === 'possible'));
  assert.equal(bidCars.lastFilterStats.trimUnknown, 1);
});

test('budget filters on the BRONVERA auction forecast, not the current bid', () => {
  const bidCars = provider();
  // B: 7170 + 0.77 × 4680 = 10774 — выше $10 000; C: 2900 + 0.77 × 2700 = 4979.
  const found = bidCars.localMatches({ make: 'Tesla', models: ['Model S'], priceMax: 10000 });

  assert.deepEqual(found.map(item => item.lotNumber).sort(), ['C', 'D']);
  assert.equal(found.find(item => item.lotNumber === 'C').expectedPriceUsd, Math.round(2900 + 0.77 * 2700));
  assert.equal(bidCars.lastFilterStats.overBudget, 3);
});

test('with nothing in budget, the cheapest lots profitable before photos are offered', async () => {
  const bidCars = provider();
  const matches = bidCars.localMatches({ make: 'Tesla', models: ['Model S'], trims: ['100D', 'P100D'] });
  const asked = [];
  const marketPrices = {
    lookup: async (vehicle) => {
      asked.push(vehicle.lotNumber);
      return { marketValueUsd: vehicle.lotNumber === 'E' ? 30000 : 60000 };
    },
  };

  const result = await cheapestPromising({ matches, marketPrices, limit: 2 });

  // По прогнозу дешевле всех B, потом A; до E очередь не дошла.
  assert.deepEqual(asked, ['B', 'A']);
  assert.deepEqual(result.listings.map(item => item.lotNumber), ['B', 'A']);
  assert.ok(result.listings[0].budgetFallback.profitWithoutPhotosUsd > 0);
  assert.equal(result.candidates, 3);
});

test('lots that lose money before photos are skipped', async () => {
  const bidCars = provider();
  const matches = bidCars.localMatches({ make: 'Tesla', models: ['Model S'], trims: ['100D'] });
  const marketPrices = { lookup: async () => ({ marketValueUsd: 9000 }) };

  const result = await cheapestPromising({ matches, marketPrices });

  assert.equal(result.listings.length, 0);
  assert.equal(result.looked, 2);
});
