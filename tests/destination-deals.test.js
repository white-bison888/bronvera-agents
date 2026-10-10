const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDeal, trimHintOf } = require('../src/economics/destination-deals');

const entry = {
  lotNumber: '1', make: 'Tesla', model: 'Model 3', year: 2021, vin: '5YJ3E1EA8MF041540',
  primaryDamage: 'Front end', repairCostUsd: 4000, auctionEstimateMin: 5000, auctionEstimateMax: 7000,
};
const listing = { mileage: 40000, fuelType: 'Electric' };

const prices = result => ({ peek: () => result });

test('no cached Polish price yet means pending, not a made-up number', () => {
  assert.equal(buildDeal({ destination: 'PL', entry, listing, prices: prices(null) }).status, 'pending');
});

test('a market without analogs is reported as no-price with its reason', () => {
  const deal = buildDeal({ destination: 'PL', entry, listing, prices: prices({ status: 'too_few_analogs', reason: 'Нашлось аналогов: 1' }) });
  assert.equal(deal.status, 'no-price');
  assert.equal(deal.priceReason, 'Нашлось аналогов: 1');
});

test('without a photo-based repair estimate the deal waits for photos', () => {
  const deal = buildDeal({ destination: 'PL', entry: { ...entry, repairCostUsd: null }, listing, prices: prices({ status: 'ok', marketValueUsd: 32000 }) });
  assert.equal(deal.status, 'waiting-photos');
});

test('a ready deal uses Polish duty and VAT with the same repair estimate', () => {
  const deal = buildDeal({ destination: 'PL', entry, listing, prices: prices({ status: 'ok', marketValueUsd: 32000, analogsCount: 28, match: { level: 'год ±1, похожий пробег' } }) });
  assert.equal(deal.status, 'ok');
  assert.ok(deal.maxBidUsd > 0);
  assert.ok(deal.breakdown.vatUsd > 0);
  assert.equal(deal.breakdown.exciseUsd, 0);
  assert.equal(deal.taxes.dutyRate, 0.1);
  assert.equal(deal.taxes.exciseRate, 0);
  assert.equal(deal.taxes.vatRate, 0.23);
  assert.ok(Number.isFinite(deal.profit.atExpectedUsd));
});

test('a petrol pickup pays excise by engine size, an unknown size takes the high rate', () => {
  const ram = { ...entry, make: 'RAM', model: '1500', vin: null };
  const price = prices({ status: 'ok', marketValueUsd: 60000 });
  const known = buildDeal({ destination: 'PL', entry: ram, listing: { mileage: 50000 }, vinInfo: { ok: true, fuel: 'gasoline', displacementL: 1.6, make: 'RAM' }, prices: price });
  const large = buildDeal({ destination: 'PL', entry: ram, listing: { mileage: 50000 }, vinInfo: { ok: true, fuel: 'gasoline', displacementL: 6.2, make: 'RAM' }, prices: price });
  const unknown = buildDeal({ destination: 'PL', entry: ram, listing: { mileage: 50000 }, prices: price });
  assert.equal(known.exciseRate, 0.031);
  assert.equal(large.exciseRate, 0.186);
  assert.equal(unknown.exciseRate, 0.186);
  assert.equal(unknown.exciseAssumed, true);
});

test('only a single-word VIN trim is used as an analog hint, never for Tesla', () => {
  assert.equal(trimHintOf({ ok: true, make: 'RAM', trim: 'TRX' }), 'TRX');
  assert.equal(trimHintOf({ ok: true, make: 'RAM', trim: 'Big Horn, Lone Star' }), '');
  assert.equal(trimHintOf({ ok: true, make: 'TESLA', trim: 'Plaid' }), '');
});


test('a petrol lot for Belarus is calculated as a physical person by engine size, or waits for the engine size', () => {
  const ram = { ...entry, make: 'RAM', model: '1500', year: 2022, vin: null };
  const price = prices({ status: 'ok', marketValueUsd: 60000 });
  const withVolume = buildDeal({ destination: 'BY', entry: ram, listing: { mileage: 50000 }, vinInfo: { ok: true, fuel: 'gasoline', displacementL: 5.7, make: 'RAM' }, prices: price });
  assert.equal(withVolume.status, 'ok');
  assert.equal(withVolume.taxes.scheme, 'physical');
  assert.equal(withVolume.taxes.volumeCc, 5700);
  assert.ok(withVolume.taxes.dutyUsd > 0);

  const without = buildDeal({ destination: 'BY', entry: ram, listing: { mileage: 50000 }, vinInfo: { ok: true, fuel: 'gasoline', make: 'RAM' }, prices: price });
  assert.equal(without.status, 'no-result');
  assert.match(without.reason, /объём/i);
});
