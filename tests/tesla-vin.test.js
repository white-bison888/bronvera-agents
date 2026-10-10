const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TeslaVinInfo, parseResult } = require('../src/providers/tesla-vin');
const { MinskMarketPrices } = require('../src/market/minsk-prices');

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-vin-')), 'cache.json');

// Ответы NHTSA, сокращённые до нужных полей (VIN из реестра 07.10).
const SAMPLES = {
  plaid: { VIN: '5YJSA1E68RF538579', Make: 'TESLA', Model: 'Model S', ModelYear: '2024', OtherEngineInfo: 'P2 Tri Motor', ErrorCode: '0' },
  dualS: { VIN: '5YJSA1E59PF500332', Make: 'TESLA', Model: 'Model S', ModelYear: '2023', OtherEngineInfo: 'P2 Dual Motor', EVDriveUnit: 'Dual Motor', DriveType: 'AWD/All-Wheel Drive', ErrorCode: '0' },
  model3: { VIN: '5YJ3E1EA8MF041540', Make: 'TESLA', Model: 'Model 3', ModelYear: '2021', OtherEngineInfo: 'Single Motor – Standard / Performance', ErrorCode: '0' },
  perfX: { VIN: '5YJXCBE48GF003902', Make: 'TESLA', Model: 'Model X', ModelYear: '2016', OtherEngineInfo: 'Dual Motor (performance)', ErrorCode: '0' },
  old: { VIN: '5YJSA1CN1DFP25780', Make: 'TESLA', Model: 'Model S', ModelYear: '2013', BatteryKWh: '81', DriveType: 'RWD/Rear-Wheel Drive', ErrorCode: '0' },
};

test('Tri Motor on Model S/X is Plaid, Dual Motor is not', () => {
  assert.equal(parseResult(SAMPLES.plaid).plaid, true);
  assert.equal(parseResult(SAMPLES.plaid).motors, 'tri');
  assert.equal(parseResult(SAMPLES.dualS).plaid, false);
  assert.equal(parseResult(SAMPLES.dualS).drive, 'awd');
});

test('Performance is only what the service confirms', () => {
  // Один мотор + «Standard / Performance»: Performance это не доказывает — метки нет.
  assert.equal(parseResult(SAMPLES.model3).performance, null);
  assert.equal(parseResult(SAMPLES.perfX).performance, 'yes');
  assert.equal(parseResult(SAMPLES.dualS).performance, null);
  // «Non-Performance» — прямое отрицание, а не Performance.
  assert.equal(parseResult({ ...SAMPLES.dualS, Model: 'Model Y', OtherEngineInfo: 'Dual Motor: Non-Performance' }).performance, null);
});

test('battery is taken only when the service gives it', () => {
  assert.equal(parseResult(SAMPLES.old).batteryKWh, 81);
  assert.equal(parseResult(SAMPLES.dualS).batteryKWh, null);
});

test('any make is decoded: fuel, engine and trim come from the VIN', () => {
  const ram = parseResult({ VIN: '1C6SRFU93NN000001', Make: 'RAM', Model: '1500', ModelYear: '2022', Trim: 'TRX', FuelTypePrimary: 'Gasoline', DisplacementL: '6.2', EngineHP: '702', ErrorCode: '0' });
  assert.equal(ram.ok, true);
  assert.equal(ram.trim, 'TRX');
  assert.equal(ram.fuel, 'gasoline');
  assert.equal(ram.displacementL, 6.2);
  assert.equal(ram.plaid, false);
  assert.equal(parseResult({ ...SAMPLES.dualS }).fuel, null);
  assert.equal(parseResult({ ...SAMPLES.dualS, FuelTypePrimary: 'Electric', ElectrificationLevel: 'BEV (Battery Electric Vehicle)' }).fuel, 'electric');
  assert.equal(parseResult({ Make: 'TOYOTA', Model: 'Camry', FuelTypePrimary: 'Gasoline', ElectrificationLevel: 'HEV (Hybrid Electric Vehicle)' }).fuel, 'hybrid');
  assert.equal(parseResult(null).ok, false);
});

test('decoded VINs are kept and not requested twice; a network failure stores nothing', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    const vins = new URLSearchParams(options.body).get('data').split(';');
    return { ok: true, json: async () => ({ Results: vins.map(vin => ({ ...SAMPLES.plaid, VIN: vin })) }) };
  };
  const file = tempFile();
  const info = new TeslaVinInfo({ cacheFile: file, fetchImpl });

  await info.ensure(['5YJSA1E68RF538579', 'bad-vin']);
  await info.ensure(['5YJSA1E68RF538579']);
  assert.equal(calls, 1);
  assert.equal(info.peek('5yjsa1e68rf538579').plaid, true);
  assert.equal(new TeslaVinInfo({ cacheFile: file, fetchImpl }).peek('5YJSA1E68RF538579').plaid, true);

  const offline = new TeslaVinInfo({ cacheFile: tempFile(), fetchImpl: async () => { throw new Error('нет сети'); } });
  await offline.ensure(['5YJSA1E68RF538579']);
  assert.equal(offline.peek('5YJSA1E68RF538579'), null);
});

const fakeSource = (listings) => ({
  name: 'auto.kufar.by',
  async search(make, model) {
    return { matched: true, label: `${make} ${model}`, listings: listings.map(l => ({ source: 'auto.kufar.by', city: 'Минск', url: `https://k/${l.priceUsd}`, vin: null, ...l })) };
  },
});

test('a Plaid lot is priced only from known Plaid listings, a regular one without them', async () => {
  const plaidVin = '5YJSA1E68RF538579';
  const stdVin = '5YJSA1E59PF500332';
  const listings = [
    { title: 'Tesla Model S', year: 2022, mileageKm: 30000, priceUsd: 50000 },
    { title: 'Tesla Model S', year: 2022, mileageKm: 35000, priceUsd: 52000 },
    { title: 'Tesla Model S', year: 2022, mileageKm: 40000, priceUsd: 54000 },
    { title: 'Tesla Model S Plaid', year: 2022, mileageKm: 30000, priceUsd: 90000 },
    { title: 'Tesla Model S', year: 2022, mileageKm: 32000, priceUsd: 88000, vin: plaidVin },
  ];
  const vinInfo = { peek: vin => (vin === plaidVin ? { ok: true, plaid: true } : vin === stdVin ? { ok: true, plaid: false } : null), ensure: async () => {} };
  const prices = new MinskMarketPrices({ cacheFile: tempFile(), sources: [fakeSource(listings)], vinInfo });
  const car = { lotNumber: '1', make: 'Tesla', model: 'Model S', year: 2022, mileage: 20000 };

  const regular = await prices.lookup({ ...car, vin: stdVin });
  assert.equal(regular.status, 'ok');
  assert.equal(regular.marketValueUsd, 52000);
  assert.equal(regular.plaid.variant, 'std');

  // Аналогов Plaid двое — меньше трёх: цена не выдаётся, причина названа.
  const plaid = await prices.lookup({ ...car, lotNumber: '2', vin: plaidVin });
  assert.equal(plaid.status, 'too_few_analogs');
  assert.match(plaid.reason, /Plaid/);
  assert.equal(plaid.analogsCount, 2);
});
