const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeFilters } = require('../src/quick-search/filters');
const { buildCatalog } = require('../src/quick-search/catalog');
const { parseQuery } = require('../src/quick-search/parse-text');
const { runQuickSearch } = require('../src/quick-search/runner');

const NOW = new Date('2026-10-07T12:00:00Z');

test('the form needs a make and either a model or a narrow range of years', () => {
  assert.equal(sanitizeFilters({}, NOW).ok, false);
  assert.deepEqual(sanitizeFilters({ make: 'Tesla' }, NOW).errors.map(e => e.field), ['models']);
  assert.equal(sanitizeFilters({ make: 'Tesla', models: ['Model Y'] }, NOW).ok, true);
  assert.equal(sanitizeFilters({ make: 'Tesla', yearFrom: 2023, yearTo: 2025 }, NOW).ok, true);
  // Пять лет и больше без модели — слишком широко.
  assert.equal(sanitizeFilters({ make: 'Tesla', yearFrom: 2018, yearTo: 2025 }, NOW).ok, false);
});

test('wrong values are errors, not silently fixed', () => {
  const { errors } = sanitizeFilters({ make: 'Ford', models: ['F-150'], yearFrom: 2024, yearTo: 2020, priceMin: 9000, priceMax: 5000, fuelTypes: ['steam'] }, NOW);
  const fields = errors.map(e => e.field);
  assert.ok(fields.includes('yearTo'));
  assert.ok(fields.includes('priceMax'));
  assert.ok(fields.includes('fuelTypes'));
  assert.ok(sanitizeFilters({ make: 'Ford', models: ['F-150'], yearFrom: 1850 }, NOW).errors.some(e => e.field === 'yearFrom'));
});

test('only the given fields reach the search; auctions are normalized', () => {
  const { filters } = sanitizeFilters({ make: ' RAM ', models: 'Ram 1500', trims: ['TRX'], auctionTypes: ['copart', 'nonsense'], maxResults: 99 }, NOW);
  assert.equal(filters.make, 'RAM');
  assert.deepEqual(filters.auctionTypes, ['Copart']);
  assert.equal(filters.maxResults, 20); // слишком много — ограничиваем двадцатью, это не ошибка
  assert.equal('priceMax' in filters, false);
  assert.equal('bodyStyles' in filters, false);
});

const vehicles = [
  { make: 'TESLA', model: 'MODEL Y' }, { make: 'TESLA', model: 'MODEL Y' }, { make: 'Tesla', model: 'Model 3' },
  { make: 'RAM', model: '1500' }, { make: 'BMW', model: 'M5' }, { make: 'FORD', model: 'F-150' },
];

test('the catalog groups names ignoring case and shows them tidily', () => {
  const catalog = buildCatalog(vehicles);
  const tesla = catalog.makes.find(m => m.make === 'Tesla');
  assert.equal(tesla.count, 3);
  assert.deepEqual(tesla.models.map(m => m.model), ['Model Y', 'Model 3']);
  assert.ok(catalog.makes.some(m => m.make === 'BMW'));
  assert.ok(catalog.makes.some(m => m.make === 'RAM'));
  assert.ok(catalog.makes.some(m => m.make === 'Ford'));
});

test('text is parsed by rules into form fields: make, model, years, budget', () => {
  const catalog = buildCatalog(vehicles);
  const a = parseQuery('Tesla Model Y 2023-2024 до $10k', catalog, NOW);
  assert.equal(a.filters.make, 'Tesla');
  assert.deepEqual(a.filters.models, ['Model Y']);
  assert.equal(a.filters.yearFrom, 2023);
  assert.equal(a.filters.yearTo, 2024);
  assert.equal(a.filters.priceMax, 10000);

  const b = parseQuery('бмв m5 2013', catalog, NOW);
  assert.equal(b.filters.make, 'BMW');
  assert.equal(b.filters.yearFrom, 2013);

  const c = parseQuery('Tesla Model 3 с 2021, пробег до 50 тыс миль', catalog, NOW);
  assert.equal(c.filters.yearFrom, 2021);
  assert.equal(c.filters.mileageMax, 50000);
  assert.equal('priceMax' in c.filters, false);
});

test('aliases fill make, model and trim: TRX, Raptor, Plaid', () => {
  const catalog = buildCatalog(vehicles);
  const trx = parseQuery('dodge ram trx 2022', catalog, NOW);
  assert.equal(trx.filters.make, 'RAM');
  assert.deepEqual(trx.filters.trims, ['TRX']);
  assert.equal(parseQuery('ford raptor', catalog, NOW).filters.trims[0], 'Raptor');
  assert.deepEqual(parseQuery('tesla plaid', catalog, NOW).filters.models, ['Model S', 'Model X']);
});

test('what cannot be understood stays empty instead of being guessed', () => {
  const parsed = parseQuery('что-нибудь красивое', buildCatalog(vehicles), NOW);
  assert.deepEqual(parsed.filters, {});
  assert.deepEqual(parsed.understood, []);
});

const deps = (overrides = {}) => {
  const written = [];
  const queued = [];
  return {
    written,
    queued,
    searchCars: async () => ({
      listings: [
        { lotNumber: '1-1', make: 'Tesla', model: 'Model Y', year: 2023, mileage: 20000, vin: '7SAYGDEE0PF000001', seller: 'State Farm Insurance', primaryDamage: 'Front end', auctionEstimateMin: 6000, auctionEstimateMax: 8000, saleDate: '2026-10-09T15:00:00Z' },
        { lotNumber: '1-2', make: 'Tesla', model: 'Model Y', year: 2023, mileage: 30000, vin: '7SAYGDEE0PF000002', seller: 'State Farm Insurance', primaryDamage: 'Rear', auctionEstimateMin: 7000, auctionEstimateMax: 9000, saleDate: '2026-10-09T16:00:00Z' },
      ],
      meta: { message: 'ok' },
    }),
    vinInfo: { ensure: async () => {}, peek: () => ({ ok: true, make: 'TESLA', fuel: 'electric', motors: 'dual' }) },
    marketPrices: { lookup: async lot => (lot.lotNumber === '1-1' ? { status: 'ok', marketValueUsd: 30000, analogsCount: 8, match: { level: 'год ±1' }, listings: [] } : { status: 'too_few_analogs', marketValueUsd: null }) },
    photoAssessor: { getCached: lot => (lot === '1-1' ? { available: true, repairCostMin: 2000, repairCostMax: 3000, photosAnalyzed: 10 } : null) },
    history: { appendRun: records => written.push(...records) },
    photoQueue: { enqueue: lots => { queued.push(...lots); return lots.length; } },
    ...overrides,
  };
};

test('the runner prices lots, calculates by the formula, saves history and queues photos', async () => {
  const d = deps();
  const steps = [];
  const out = await runQuickSearch({ filters: { make: 'Tesla', models: ['Model Y'], maxResults: 10 }, deps: d, jobId: 'job1', now: () => NOW, report: (s) => steps.push(s) });

  assert.deepEqual(out.lots, ['1-1', '1-2']);
  assert.equal(out.stats.found, 2);
  assert.equal(out.stats.withPrice, 1);
  assert.equal(out.stats.noPrice, 1);
  assert.equal(out.stats.photosQueued, 1);
  assert.deepEqual(d.queued, [{ lotNumber: '1-2' }]);

  const [first, second] = d.written;
  // Лот с фото и ценой получает расчёт, как в основном поиске.
  assert.ok(['BUY', 'WATCH', 'SKIP'].includes(first.decision));
  assert.ok(first.maxBidUsd > 0);
  assert.equal(first.quickSearch.jobId, 'job1');
  // Без цены в Беларуси вердикта нет, и это видно.
  assert.equal(second.maxBidUsd, null);
  assert.ok(['NEEDS_MARKET_DATA', 'PENDING_PHOTOS'].includes(second.decision));
  assert.deepEqual(steps.filter((s, i) => steps.indexOf(s) === i), ['search', 'vin', 'prices', 'save']);
});

test('no lots found means nothing is written and nothing is queued', async () => {
  const d = deps({ searchCars: async () => ({ listings: [], meta: { message: 'пусто' } }) });
  const out = await runQuickSearch({ filters: { make: 'Tesla', maxResults: 5 }, deps: d, now: () => NOW });
  assert.deepEqual(out.lots, []);
  assert.equal(out.stats.message, 'пусто');
  assert.equal(d.written.length, 0);
  assert.equal(d.queued.length, 0);
});

test('the number of lots is limited by maxResults', async () => {
  const d = deps();
  const out = await runQuickSearch({ filters: { make: 'Tesla', models: ['Model Y'], maxResults: 1 }, deps: d, now: () => NOW });
  assert.equal(out.lots.length, 1);
});


test('junk model names from the registry never reach the dropdown', () => {
  const catalog = buildCatalog([
    { make: 'Tesla', model: 'Model Y' }, { make: 'Tesla', model: 'Model' }, { make: 'Tesla', model: 'MDL' },
    { make: 'Tesla', model: 'Y' }, { make: 'Tesla', model: 'Model 3 5YJ3E1EAXMF851817' }, { make: 'Tesla', model: 'Model 3' },
  ]);
  assert.deepEqual(catalog.makes[0].models.map(m => m.model), ['Model Y', 'Model 3']);
});

test('Russian make names and a single year are understood', () => {
  const catalog = buildCatalog(vehicles);
  const bmw = parseQuery('бмв м5 2013 пробег до 80 тыс миль', catalog, NOW);
  assert.equal(bmw.filters.make, 'BMW');
  assert.deepEqual(bmw.filters.models, ['M5']);
  assert.equal(bmw.filters.yearFrom, 2013);
  assert.equal(bmw.filters.mileageMax, 80000);
  assert.ok(bmw.understood.includes('год 2013'));
  assert.equal(parseQuery('тесла model y', catalog, NOW).filters.make, 'Tesla');
});


test('Tesla trim codes are recognized: 100D, P100D, Performance, Long Range', () => {
  const catalog = buildCatalog(vehicles);
  assert.deepEqual(parseQuery('Tesla Model S 100D или P100D, прогноз до $10000', catalog, NOW).filters.trims, ['100D', 'P100D']);
  assert.deepEqual(parseQuery('Tesla Model 3 Performance 2022', catalog, NOW).filters.trims, ['Performance']);
  assert.deepEqual(parseQuery('tesla model y long range', catalog, NOW).filters.trims, ['Long Range']);
  // С псевдонимом Plaid комплектации складываются, а не затирают друг друга.
  assert.deepEqual(parseQuery('Tesla 100D, P100D, Plaid', catalog, NOW).filters.trims, ['100D', 'P100D', 'Plaid']);
});


test('photo queue goes in order of the formula estimate without photos, best candidates first', async () => {
  const d = deps({
    searchCars: async () => ({
      listings: [
        { lotNumber: 'A', make: 'Tesla', model: 'Model Y', year: 2023, mileage: 20000, vin: '7SAYGDEE0PF000011', seller: 'State Farm Insurance', primaryDamage: 'Front end', auctionEstimateMin: 12000, auctionEstimateMax: 14000, saleDate: '2026-10-09T15:00:00Z' },
        { lotNumber: 'B', make: 'Tesla', model: 'Model Y', year: 2023, mileage: 20000, vin: '7SAYGDEE0PF000012', seller: 'State Farm Insurance', primaryDamage: 'Front end', auctionEstimateMin: 4000, auctionEstimateMax: 5000, saleDate: '2026-10-09T16:00:00Z' },
      ],
    }),
    marketPrices: { lookup: async () => ({ status: 'ok', marketValueUsd: 30000, analogsCount: 8, match: { level: 'год ±1' }, listings: [] }) },
    photoAssessor: { getCached: () => null },
  });
  await runQuickSearch({ filters: { make: 'Tesla', models: ['Model Y'], maxResults: 10 }, deps: d, now: () => NOW });
  // B дешевле по прогнозу, значит выгоднее — его фото разбираются первыми, хотя торги у A раньше.
  assert.deepEqual(d.queued.map(item => item.lotNumber), ['B', 'A']);
});

test('extra filters run after the search: the registry is asked for more lots and the result is cut to maxResults', async () => {
  const asked = [];
  const d = deps({
    searchCars: async (options) => {
      asked.push(options.maxResults);
      return { listings: [
        { lotNumber: '1-1', make: 'Tesla', model: 'Model Y', year: 2023, mileage: 30000, vin: '7SAYGDEE0PF000001', seller: 'Geico', primaryDamage: '---', secondaryDamage: 'Hail', saleDate: '2026-10-09T16:00:00Z', auctionEstimateMin: 7000, auctionEstimateMax: 9000 },
        { lotNumber: '1-2', make: 'Tesla', model: 'Model Y', year: 2023, mileage: 30000, vin: '7SAYGDEE0PF000002', seller: 'Geico', primaryDamage: 'Front end', secondaryDamage: '---', saleDate: '2026-10-09T16:00:00Z', auctionEstimateMin: 7000, auctionEstimateMax: 9000 },
      ], meta: {} };
    },
    history: { appendRun: () => {}, readAll: () => [] },
  });
  const out = await runQuickSearch({ filters: { make: 'Tesla', models: ['Model Y'], maxResults: 5, damageMode: 'noImpact' }, deps: d, now: () => NOW });
  assert.deepEqual(out.lots, ['1-1']);
  assert.equal(asked[0], 40);
  assert.equal(out.stats.droppedByFilters.damage, 1);
});
