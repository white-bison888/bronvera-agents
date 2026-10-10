const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalCwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-vintrim-'));
process.chdir(temp);

const BidCarsProvider = require('../src/providers/bidcars');
const { getVinInfo, parseResult } = require('../src/providers/tesla-vin');

after(() => { process.chdir(originalCwd); fs.rmSync(temp, { recursive: true, force: true }); });

const provider = new BidCarsProvider({ cacheFile: path.join(temp, 'cache.json') });
const filters = provider.normalizeFilters({ make: 'RAM', trims: ['TRX'] });

const decode = (vin, Trim) => {
  getVinInfo().cache[vin] = parseResult({ VIN: vin, Make: 'RAM', Model: '1500', ModelYear: '2022', Trim, ErrorCode: '0' });
};

const car = vin => ({ lotNumber: vin, make: 'RAM', model: '1500', year: 2022, vin, auction: 'Copart', saleDate: new Date(Date.now() + 864e5).toISOString() });

test('a lot without an auction trim is confirmed by the trim from its VIN', () => {
  decode('1C6SRFU93NN000001', 'TRX');
  const result = provider.evaluateFilters(car('1C6SRFU93NN000001'), filters);
  assert.equal(result.trimStatus, 'confirmed');
  assert.equal(result.trimSource, 'vin');
  assert.ok(!result.mismatchFields.includes('trim'));
});

test('a different trim in the VIN is a real mismatch, not "unknown"', () => {
  decode('1C6SRFFT0NN000001', 'Big Horn, Lone Star');
  const result = provider.evaluateFilters(car('1C6SRFFT0NN000001'), filters);
  assert.equal(result.trimStatus, 'mismatch');
  assert.ok(result.mismatchFields.includes('trim'));
});

test('no VIN decode and no auction trim stays unknown, as before', () => {
  const result = provider.evaluateFilters(car('1C6SRFU93NN999999'), filters);
  assert.equal(result.trimStatus, 'unknown');
});

const rank = (cars, wanted) => provider.filterAndRank(cars, provider.normalizeFilters({ make: 'RAM', trims: wanted }), 20);
const ramCar = (vin, extra = {}) => ({ ...car(vin), runAndDrive: 'Run and Drive', seller: 'Geico', ...extra });

test('when no lot has a confirmed trim, the lots of the model are shown marked "trim not confirmed"', () => {
  decode('1C6SRFFT0NN000002', 'Big Horn, Lone Star');
  const result = rank([ramCar('1C6SRFU93NN777777'), ramCar('1C6SRFU93NN777778'), ramCar('1C6SRFFT0NN000002')], ['TRX']);

  // Лот с другой комплектацией по VIN остаётся отсеянным, неподтверждённые показаны.
  assert.deepEqual(result.map(item => item.vin).sort(), ['1C6SRFU93NN777777', '1C6SRFU93NN777778']);
  assert.ok(result.every(item => item.trimStatus === 'unknown' && item.trimUnconfirmed.join() === 'TRX' && item.filterStatus === 'PARTIAL'));
  assert.equal(provider.lastFilterStats.trimFallback, 2);
  assert.match(provider.makeResult(result, {}, { vehicles: [] }, 'k', 'fresh', 'updated_complete').meta.message, /комплектация у них не подтверждена/);
});

test('a confirmed lot hides the unconfirmed ones; other failed filters never trigger the fallback', () => {
  decode('1C6SRFU93NN000003', 'TRX');
  const confirmed = rank([ramCar('1C6SRFU93NN000003'), ramCar('1C6SRFU93NN777779')], ['TRX']);

  assert.deepEqual(confirmed.map(item => item.vin), ['1C6SRFU93NN000003']);
  assert.equal(confirmed[0].trimUnconfirmed, undefined);

  // Бюджет не прошёл — это другая причина, показывать «комплектация не подтверждена» нельзя.
  const filtered = provider.filterAndRank([ramCar('1C6SRFU93NN777780')], provider.normalizeFilters({ make: 'RAM', trims: ['TRX'], priceMax: 1 }), 20);
  assert.deepEqual(filtered, []);
});

test('a truncated trim that already names another version is not "unconfirmed"', () => {
  const lots = [ramCar('1C6SRFU93NN888881', { trim: 'Performance All-...' }), ramCar('1C6SRFU93NN888882', { trim: '2022 RAM 1500' })];
  const result = rank(lots, ['TRX']);

  assert.deepEqual(result.map(item => item.vin), ['1C6SRFU93NN888882']);
});

test('a short page of the model search marks the search complete for a while, not "depth limit"', () => {
  const bucket = { vehicles: [], highestPageFetched: 10 };
  const wanted = provider.normalizeFilters({ make: 'Tesla', models: ['Model 3'], yearFrom: 2024, yearTo: 2024, fuelTypes: ['electric'] });

  assert.equal(provider.isFilteredComplete(bucket, wanted), false);
  provider.markFilteredComplete(bucket, wanted, 50);
  assert.equal(provider.isFilteredComplete(bucket, wanted), false); // полная страница — это не вся выдача
  provider.markFilteredComplete(bucket, wanted, 3);
  assert.equal(provider.isFilteredComplete(bucket, wanted), true);
  // Другая модель или годы — другая выдача.
  assert.equal(provider.isFilteredComplete(bucket, provider.normalizeFilters({ make: 'Tesla', models: ['Model Y'], yearFrom: 2024, yearTo: 2024, fuelTypes: ['electric'] })), false);
});
