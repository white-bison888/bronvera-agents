const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MinskMarketPrices, KufarSource, OnlinerSource, matchByName } = require('../src/market/minsk-prices');

const tempCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-market-')), 'cache.json');

const fakeSource = (name, listings, calls = []) => ({
  name,
  async search(make, model, yearFrom, yearTo) {
    calls.push({ make, model, yearFrom, yearTo });
    return { matched: true, label: `${make} ${model}`, listings: listings.map(l => ({ source: name, vin: null, city: 'Минск', url: `https://${name}/${l.title}`, ...l })) };
  },
});

const lot = { lotNumber: '1-63873226', make: 'Tesla', model: 'MODEL 3', year: 2022, mileage: 42000 };

test('model names match the longest catalog entry the lot model starts with', () => {
  const catalog = [{ name: 'Model 3' }, { name: 'Model S' }, { name: 'Model' }];
  assert.equal(matchByName(catalog, 'MODEL 3 LONG RANGE', item => item.name).name, 'Model 3');
  assert.equal(matchByName(catalog, 'Cybertruck', item => item.name), null);
});

test('median comes from clean, unique analogs near the lot', async () => {
  const kufar = [
    { title: 'Tesla Model 3', year: 2022, mileageKm: 70000, priceUsd: 22000 },
    { title: 'Tesla Model 3', year: 2021, mileageKm: 60000, priceUsd: 21000 },
    { title: 'Tesla Model 3 на запчасти', year: 2022, mileageKm: 80000, priceUsd: 9000 },
    { title: 'Tesla Model 3', year: 2023, mileageKm: 50000, priceUsd: 25000 },
    { title: 'Tesla Model 3 кредит', year: 2022, mileageKm: 90000, priceUsd: 2000 },
    { title: 'Tesla Model 3 далеко по пробегу', year: 2022, mileageKm: 300000, priceUsd: 12000 },
  ];
  const onliner = [
    // Та же машина, что первая на Kufar: считается один раз.
    { title: 'Tesla Model 3 (I)', year: 2022, mileageKm: 70500, priceUsd: 22100 },
    { title: 'Tesla Model 3 (I)', year: 2022, mileageKm: 65000, priceUsd: 23000 },
  ];
  const prices = new MinskMarketPrices({ cacheFile: tempCache(), sources: [fakeSource('auto.kufar.by', kufar), fakeSource('ab.onliner.by', onliner)] });
  const result = await prices.lookup(lot);

  assert.equal(result.status, 'ok');
  assert.equal(result.lotNumber, '1-63873226');
  assert.equal(result.match.level, 'год ±1, похожий пробег');
  assert.equal(result.analogsCount, 4);
  assert.equal(result.marketValueUsd, 22500);
  assert.deepEqual(result.bySource, { 'auto.kufar.by': 3, 'ab.onliner.by': 1 });
  assert.equal(result.filtered.junk, 1);
  assert.equal(result.filtered.duplicates, 1);
  assert.equal(result.filtered.outliers, 1);
  assert.equal(result.closestAnalogs[0].alsoAt.length, 1);
});

test('too few analogs widen the search and never invent a price', async () => {
  const kufar = [
    { title: 'Tesla Model S', year: 2013, mileageKm: 200000, priceUsd: 14000 },
    { title: 'Tesla Model S', year: 2014, mileageKm: 230000, priceUsd: 13500 },
    { title: 'Tesla Model S', year: 2012, mileageKm: 250000, priceUsd: 15000 },
  ];
  const prices = new MinskMarketPrices({ cacheFile: tempCache(), sources: [fakeSource('auto.kufar.by', kufar)] });
  const widened = await prices.lookup({ make: 'Tesla', model: 'Model S', year: 2013, mileage: 46000 });

  assert.equal(widened.match.level, 'год ±1, любой пробег');
  assert.equal(widened.marketValueUsd, 14000);

  const scarce = new MinskMarketPrices({ cacheFile: tempCache(), sources: [fakeSource('auto.kufar.by', kufar.slice(0, 2))] });
  const result = await scarce.lookup({ make: 'Tesla', model: 'Model S', year: 2013, mileage: 46000 });

  assert.equal(result.status, 'too_few_analogs');
  assert.equal(result.marketValueUsd, null);
});

test('results are cached for a day, source failures are not', async () => {
  const calls = [];
  const cacheFile = tempCache();
  const listings = [20000, 21000, 22000].map((priceUsd, i) => ({ title: `car ${i}`, year: 2022, mileageKm: 60000 + i * 5000, priceUsd }));
  const prices = new MinskMarketPrices({ cacheFile, sources: [fakeSource('auto.kufar.by', listings, calls)] });

  assert.equal((await prices.lookup(lot)).cached, false);
  // Соседний лот той же модели с близким пробегом делит выборку.
  assert.equal((await prices.lookup({ ...lot, lotNumber: 'other', mileage: 43000 })).cached, true);
  assert.equal(calls.length, 1);

  const reloaded = new MinskMarketPrices({ cacheFile, sources: [fakeSource('auto.kufar.by', [], calls)] });
  assert.equal((await reloaded.lookup(lot)).marketValueUsd, 21000);

  const broken = { name: 'ab.onliner.by', async search() { throw new Error('ab.onliner.by ответил 503'); } };
  const failing = new MinskMarketPrices({ cacheFile: tempCache(), sources: [broken] });
  const failed = await failing.lookup(lot);
  assert.equal(failed.status, 'source_error');
  assert.equal(failed.marketValueUsd, null);
  assert.deepEqual(failing.cache, {});
});

test('lot without make, model or year is refused', async () => {
  const prices = new MinskMarketPrices({ cacheFile: tempCache(), sources: [] });
  assert.equal((await prices.lookup({ lotNumber: '1', make: 'Tesla' })).status, 'not_enough_lot_data');
});

test('kufar and onliner listings are read in dollars and kilometres', async () => {
  const http = {
    async json(url) {
      if (url.includes('view=taxonomy') && !url.includes('mark_'))
        return [{ value: 'category_2010.mark_tesla', labels: { ru: 'Tesla' } }];
      if (url.includes('view=taxonomy'))
        return [{ value: 'category_2010.mark_tesla.model_model_3', labels: { ru: 'Model 3' } }];
      if (url.includes('kufar'))
        return {
          ads: [{ subject: 'Tesla Model 3', price_usd: '2185000', ad_link: 'https://auto.kufar.by/vi/1', ad_parameters: [
            { p: 'regdate', v: '2022', vl: '2022' }, { p: 'mileage', v: 67000, vl: '' }, { p: 'region', v: 7, vl: 'Минск' }] }],
          pagination: { pages: [{ label: 'self', token: null }] },
        };
      if (url.endsWith('/manufacturers'))
        return [{ id: 112, name: 'Tesla' }];
      if (url.endsWith('/manufacturers/112'))
        return { models: [{ id: 2780, name: 'Model 3' }] };
      return {
        adverts: [{ title: 'Tesla Model 3 (I)', html_url: 'https://ab.onliner.by/tesla/model-3/1', location: { city: { name: 'Гомель' } },
          specs: { year: 2022, odometer: { unit: 'mile', value: 10000 } }, price: { converted: { USD: { amount: '24768.82' } } } }],
        page: { current: 1, last: 1 },
      };
    },
  };

  const kufar = await new KufarSource(http).search('Tesla', 'MODEL 3', 2020, 2024);
  assert.deepEqual(kufar.listings[0], { source: 'auto.kufar.by', title: 'Tesla Model 3', year: 2022, mileageKm: 67000, priceUsd: 21850, city: 'Минск', vin: null, url: 'https://auto.kufar.by/vi/1' });

  const onliner = await new OnlinerSource(http).search('Tesla', 'MODEL 3', 2020, 2024);
  assert.equal(onliner.listings[0].priceUsd, 24768.82);
  assert.equal(onliner.listings[0].mileageKm, 16093);
});

test('a lot far above the analogs mileage gets no market price', async () => {
  const listings = [50000, 60000, 70000, 125000].map((mileageKm, i) => ({ title: `Tesla Model Y ${i}`, year: 2023, mileageKm, priceUsd: 27000 + i * 500 }));
  const prices = new MinskMarketPrices({ cacheFile: tempCache(), sources: [fakeSource('auto.kufar.by', listings)] });
  const result = await prices.lookup({ lotNumber: '1-66239746', make: 'Tesla', model: 'MODEL Y', year: 2023, mileage: 151000 });

  assert.equal(result.status, 'mileage_out_of_range');
  assert.equal(result.marketValueUsd, null);
  assert.match(result.reason, /243 тыс\. км/);
});

test('a near-new lot without same-year listings is priced by older analogs and marked as underestimated', async () => {
  const listings = [
    { title: 'Tesla Model Y', year: 2026, mileageKm: 3500, priceUsd: 67500 },
    ...[27000, 28000, 29000, 30000].map((priceUsd, i) => ({ title: `Tesla Model Y 2023 ${i}`, year: 2023, mileageKm: 40000 + i * 10000, priceUsd })),
  ];
  const calls = [];
  const prices = new MinskMarketPrices({ cacheFile: tempCache(), sources: [fakeSource('auto.kufar.by', listings, calls)] });
  const result = await prices.lookup({ lotNumber: '1-58352106', make: 'Tesla', model: 'MODEL Y', year: 2026, mileage: 2000 });

  assert.equal(calls[0].yearFrom, 2023);
  assert.equal(result.status, 'ok');
  assert.equal(result.match.underestimated, true);
  assert.equal(result.match.yearTo, 2026);
  // Единственное объявление 2026 года вдвое дороже остальных и отсеивается как выброс.
  assert.equal(result.marketValueUsd, 28500);
});
