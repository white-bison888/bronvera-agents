const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalCwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-screener-'));
process.chdir(temp);

const BidCarsProvider = require('../src/providers/bidcars');
const DailyScreener = require('../src/screener/screener');
const config = require('../src/screener/config');
const history = require('../src/history/store');
const queue = require('../src/photos/queue');
const { mapSearchItem, parseCloseTime } = require('../src/providers/bidcars-search-api');
const { prefilterReason, rankTiers } = require('../src/screener/select');

after(() => { process.chdir(originalCwd); fs.rmSync(temp, { recursive: true, force: true }); });

// Ответ /app/search/request, сокращённый до нужных полей (лот из выдачи 15.09).
const apiItem = (overrides = {}) => ({
  loss_type: 'Collision',
  primary_damage: 'Right side',
  start_code: 'Run / Drive',
  seller: 'State Farm Grou...',
  seller_long: 'State Farm Group Insurance',
  tag: '2023-Tesla-Model-Y-7SAYGDEE5PA180100',
  lot: '0-45994858',
  vin: '7SAYGDEE5PA180100',
  odometer: 92910,
  location: 'Long Island (NY)',
  sale_document_split: 'Mv-907a (New york)',
  sale_document_external: 'MV-907A (New York)',
  prebid_close_time_lang: { en: 'Tue 15 Sep, 15:30 GMT+2' },
  time_left: 23436,
  prebid_price: '$8,800',
  estimated_min: 8150,
  estimated_max: 12210,
  specs: { key_info: 'Present' },
  img_large: { img_1: 'https://pluto.bid.car/0-45994858/1.jpg' },
  ...overrides,
});

test('a search API item becomes a registry lot with full seller, damage and auction time', () => {
  const lot = mapSearchItem(apiItem(), { fetchedAt: new Date('2026-09-15T06:59:00Z'), make: 'Tesla' });

  assert.equal(lot.lotNumber, '0-45994858');
  assert.equal(lot.auction, 'IAAI');
  assert.equal(lot.make, 'Tesla');
  assert.equal(lot.model, 'Model Y');
  assert.equal(lot.year, 2023);
  assert.equal(lot.mileage, 92910);
  assert.equal(lot.primaryDamage, 'Collision');
  assert.equal(lot.secondaryDamage, 'Right side');
  assert.equal(lot.seller, 'State Farm Group Insurance');
  assert.equal(lot.runAndDrive, 'Run and Drive');
  assert.equal(lot.currentBid, 8800);
  assert.equal(lot.saleDate, '2026-09-15T13:30:00.000Z');
  assert.equal(lot.auctionEstimateMin, 8150);
  assert.equal(lot.auctionEstimateMax, 12210);
  assert.equal(lot.fuelType, 'Electric');
  assert.equal(lot.url, 'https://bid.cars/en/lot/0-45994858/2023-Tesla-Model-Y-7SAYGDEE5PA180100');
});

test('auction close time without a year rolls into next year in late December', () => {
  assert.equal(parseCloseTime('Mon 4 Jan, 16:00 GMT+2', new Date('2026-12-30T10:00:00Z')).toISOString(), '2027-01-04T14:00:00.000Z');
  assert.equal(parseCloseTime('nonsense', new Date()), null);
});

const now = new Date('2026-09-16T04:00:00Z'); // 07:00 по Минску
const lot = (overrides = {}) => ({
  lotNumber: '1-1',
  make: 'Tesla',
  model: 'Model Y',
  year: 2023,
  mileage: 20000,
  fuelType: 'Electric',
  runAndDrive: 'Run and Drive',
  seller: 'Geico',
  primaryDamage: 'Rear',
  titleType: 'SC (California)',
  saleDate: '2026-09-16T18:00:00Z',
  auctionEstimateMin: 6000,
  auctionEstimateMax: 9000,
  ...overrides,
});

test('prefilter drops flood, fire, destruction titles, non-insurers and bad auction timing', () => {
  const reason = overrides => prefilterReason(lot(overrides), { now, config });

  assert.equal(reason({}), null);
  assert.equal(reason({ primaryDamage: 'Water / flood' }), 'затопление');
  assert.equal(reason({ primaryDamage: 'Burn' }), 'пожар');
  assert.equal(reason({ titleType: 'CD (Florida)', titleDocument: 'CERTIFICATE OF DESTRUCTION (FL)' }), 'документ без права регистрации');
  assert.equal(reason({ seller: 'Non-insurance Company' }), 'продавец не страховая');
  assert.equal(reason({ runAndDrive: 'Starts' }), 'не Run and Drive');
  assert.equal(reason({ saleDate: '2026-09-16T06:00:00Z' }), 'торги слишком скоро — фото не успеть');
  assert.equal(reason({ saleDate: '2026-09-19T06:00:00Z' }), 'торги позже 48 часов — в следующий скан');
  assert.equal(reason({ auctionEstimateMin: null }), 'нет прогноза bid.cars');
  assert.equal(reason({ auctionEstimateMin: 15000, auctionEstimateMax: 20000 }), 'прогноз выше $15000');
});

test('two tiers rank by expected profit, the cheaper tier keeps only lots up to $10 000', () => {
  const item = (lotNumber, expectedPriceUsd, profitAtExpectedUsd, repairRoomUsd) => ({
    lot: { lotNumber }, expectedPriceUsd, profitAtExpectedUsd, repairRoomUsd,
  });

  const tiers = rankTiers([
    item('a', 14000, 3000, 12000),
    item('b', 9000, 5000, 9000),
    item('c', 8000, -1000, 1500), // запаса на ремонт нет — не кандидат
    item('d', 9500, 1000, 8000),
  ], config);

  assert.deepEqual(tiers[0].candidates.map(c => [c.lot.lotNumber, c.rank]), [['b', 1], ['a', 2], ['d', 3]]);
  assert.deepEqual(tiers[1].candidates.map(c => c.lot.lotNumber), ['b', 'd']);
  assert.equal(tiers[1].label, 'до $10 000');
});

test('daily run scans slices with retries, writes the day file, history and photo queue', async () => {
  const bidCars = new BidCarsProvider({ cacheFile: path.join(temp, 'data', 'bidcars-cache.json') });
  const fetchedAt = new Date('2026-09-16T04:00:00Z');

  let calls = 0;
  const fetchSlice = async (url) => {
    calls += 1;

    if (url.includes('Model+3') && calls < 5)
      throw new Error('Bid.Cars ответил 403');

    if (!url.includes('model=Model+Y') || !url.includes('year-from=2023'))
      return { items: [], hasMore: false, activeCount: 0 };

    return {
      hasMore: true,
      activeCount: 90,
      items: [
        apiItem({ lot: '0-1', tag: '2023-Tesla-Model-Y-VIN1', vin: 'VIN1', loss_type: 'Rear', primary_damage: null, prebid_close_time_lang: { en: 'Wed 16 Sep, 20:30 GMT+2' }, estimated_min: 6000, estimated_max: 9000, odometer: 15000 }),
        apiItem({ lot: '0-2', tag: '2023-Tesla-Model-Y-VIN2', vin: 'VIN2', loss_type: 'Water / flood', primary_damage: null, prebid_close_time_lang: { en: 'Wed 16 Sep, 20:30 GMT+2' } }),
        apiItem({ lot: '1-3', tag: '2024-Tesla-MODEL-Y-VIN3', vin: 'VIN3', loss_type: 'Front end', primary_damage: null, prebid_close_time_lang: { en: 'Thu 17 Sep, 19:00 GMT+2' }, estimated_min: 11000, estimated_max: 14000, odometer: 9000 }),
      ],
    };
  };

  const screener = new DailyScreener({
    bidCars,
    marketPrices: { lookup: async () => ({ marketValueUsd: 38000, analogsCount: 6, match: { level: 'год ±1, похожий пробег' } }) },
    photoAssessor: { getCached: () => null },
    fetchSlice,
    config: { ...config, slices: config.slices.slice(0, 4) },
    sleep: async () => {},
    log: () => {},
  });

  const state = await screener.run({ now: () => fetchedAt });

  assert.equal(state.status, 'done');
  assert.equal(state.slices.find(s => s.label === 'Model 3 до 2020').attempts, 2);
  assert.ok(state.slices.every(s => s.status === 'ok'));
  assert.equal(state.excluded['затопление'], 1);

  const [upTo15k, upTo10k] = state.tiers;
  assert.deepEqual(upTo15k.candidates.map(c => c.lotNumber), ['0-1', '1-3']);
  assert.deepEqual(upTo10k.candidates.map(c => c.lotNumber), ['0-1']);
  assert.deepEqual(upTo15k.candidates[0].inTiers, { upTo15k: 1, upTo10k: 1 });

  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'data', 'screener', '2026-09-16.json'), 'utf8'));
  assert.equal(saved.status, 'done');

  const records = history.readAll();
  assert.deepEqual(records.map(r => r.lotNumber).sort(), ['0-1', '1-3']);
  assert.ok(records.every(r => r.decision === 'PENDING_PHOTOS' && r.screener.day === '2026-09-16'));

  // Ближайшие торги — первыми в очереди фото.
  assert.deepEqual(queue.read().items.map(i => i.lotNumber), ['0-1', '1-3']);
  assert.equal(bidCars.findByLotNumber('1-3').seller, 'State Farm Group Insurance');

  // Повторный запуск в тот же день историю не дублирует.
  await screener.run({ now: () => fetchedAt });
  assert.equal(history.readAll().length, 2);

  const live = screener.withLiveState(screener.latestDay(fetchedAt));
  assert.equal(live.tiers[0].candidates[0].now.decision, 'PENDING_PHOTOS');
  assert.equal(live.tiers[0].candidates[0].now.photoQueue.status, 'pending');
});

test('schedule runs only on pilot days after 7:00 Minsk and retries a failed scan at most three times', () => {
  const screener = new DailyScreener({ bidCars: {}, marketPrices: {}, config, dataDir: path.join(temp, 'schedule'), log: () => {} });
  const at = iso => new Date(iso);

  assert.equal(screener.shouldRun(at('2026-09-17T03:30:00Z')), false); // 06:30 Минск
  assert.equal(screener.shouldRun(at('2026-09-17T04:05:00Z')), true);
  assert.equal(screener.shouldRun(at('2026-09-19T05:00:00Z')), false); // пилот окончен
  assert.equal(screener.shouldRun(at('2026-09-14T05:00:00Z')), false);

  screener.writeDay('2026-09-17', { status: 'failed', attempts: 1, startedAt: '2026-09-17T04:05:00Z' });
  assert.equal(screener.shouldRun(at('2026-09-17T04:20:00Z')), false);
  assert.equal(screener.shouldRun(at('2026-09-17T04:40:00Z')), true);

  screener.writeDay('2026-09-17', { status: 'failed', attempts: 3, startedAt: '2026-09-17T04:05:00Z' });
  assert.equal(screener.shouldRun(at('2026-09-17T06:00:00Z')), false);

  screener.writeDay('2026-09-17', { status: 'done', attempts: 1, startedAt: '2026-09-17T04:05:00Z' });
  assert.equal(screener.shouldRun(at('2026-09-17T09:00:00Z')), false);
});
