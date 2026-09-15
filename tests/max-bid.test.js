const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateMaxBid } = require('../src/economics/max-bid');

const year = new Date().getFullYear();
const photoAssessment = { available: true, repairCostMin: 2000, repairCostMax: 4000, photosAnalyzed: 12 };
const lot = (extra = {}) => ({ lotNumber: 'L', year: year - 2, marketValueUsd: 30000, photoAssessment, ...extra });

test('ceiling leaves exactly the minimum profit; expected price follows the forecast', () => {
  const result = calculateMaxBid(lot({ auctionEstimateMin: 8000, auctionEstimateMax: 12000 }));
  assert.equal(result.breakdown.repairCostUsd, 3000);
  assert.equal(result.forecast.expectedUsd, Math.round(8000 + 0.77 * 4000));

  const atCeiling = calculateMaxBid(lot({ auctionEstimateMin: result.maxBidUsd, auctionEstimateMax: result.maxBidUsd }));
  assert.ok(Math.abs(atCeiling.profit.atExpectedUsd - 2000) <= 2);
});

test('verdict compares the ceiling with the bid.cars forecast', () => {
  const { maxBidUsd } = calculateMaxBid(lot());
  assert.equal(calculateMaxBid(lot({ auctionEstimateMin: maxBidUsd - 3000, auctionEstimateMax: maxBidUsd - 100 })).verdict, 'BUY');
  assert.equal(calculateMaxBid(lot({ auctionEstimateMin: maxBidUsd - 1000, auctionEstimateMax: maxBidUsd + 1000 })).verdict, 'WATCH');
  assert.equal(calculateMaxBid(lot({ auctionEstimateMin: maxBidUsd + 100, auctionEstimateMax: maxBidUsd + 3000 })).verdict, 'SKIP');
  // Без прогноза формула вердикт не выносит — остаётся решение аналитиков.
  assert.equal(calculateMaxBid(lot()).verdict, null);
});

test('VAT applies only to cars older than five years; quota removes the duty', () => {
  const fresh = calculateMaxBid(lot({ year: year - 3 }));
  const old = calculateMaxBid(lot({ year: year - 6 }));
  assert.equal(fresh.assumptions.vatExempt, true);
  assert.equal(old.assumptions.vatExempt, false);
  assert.ok(old.maxBidUsd < fresh.maxBidUsd);
  assert.equal(calculateMaxBid(lot({ year: year - 5 })).assumptions.vatAgeBorderline, true);

  const quota = calculateMaxBid(lot(), { evDutyFreeQuota: true });
  assert.equal(quota.assumptions.dutyRate, 0);
  assert.ok(quota.maxBidUsd > fresh.maxBidUsd);
});

test('a lot that cannot earn the minimum profit is skipped at any price', () => {
  const result = calculateMaxBid(lot({ marketValueUsd: 5000, auctionEstimateMin: 1000, auctionEstimateMax: 2000 }));
  assert.equal(result.maxBidUsd, 0);
  assert.equal(result.viable, false);
  assert.equal(result.verdict, 'SKIP');
});

test('a lot from a known non-insurance seller is skipped without a ceiling', () => {
  const result = calculateMaxBid(lot({ seller: 'Non-insurance Company', auctionEstimateMin: 4000, auctionEstimateMax: 7000 }));
  assert.equal(result.verdict, 'SKIP');
  assert.equal(result.maxBidUsd, null);
  assert.match(result.reason, /страховая/);
  // Неизвестный продавец расчёт не блокирует.
  assert.notEqual(calculateMaxBid(lot({ seller: '-' })).maxBidUsd, null);
});

test('lots in Hawaii, Alaska and Puerto Rico pay for the extra leg instead of being dropped', () => {
  const forecast = { auctionEstimateMin: 3000, auctionEstimateMax: 5000 };
  const mainland = calculateMaxBid(lot({ ...forecast, location: 'Culpeper (VA)' }));
  const hawaii = calculateMaxBid(lot({ ...forecast, location: 'Honolulu (HI)' }));

  assert.equal(mainland.breakdown.remoteLocationSurchargeUsd, 0);
  assert.equal(mainland.assumptions.remoteLocation, null);
  assert.equal(hawaii.breakdown.remoteLocationSurchargeUsd, 2700);
  assert.equal(hawaii.assumptions.remoteLocation, 'HI');
  assert.equal(calculateMaxBid(lot({ location: 'Hawaii - K... (HI)' })).assumptions.remoteLocation, 'HI');
  assert.equal(calculateMaxBid(lot({ location: 'Anchorage (AK)' })).breakdown.remoteLocationSurchargeUsd, 3400);
  assert.equal(calculateMaxBid(lot({ location: 'San Juan (PR)' })).breakdown.remoteLocationSurchargeUsd, 1300);

  // Доставка входит в таможенную стоимость: прибыль теряет доплату вместе с пошлиной на неё.
  assert.equal(mainland.profit.atExpectedUsd - hawaii.profit.atExpectedUsd, Math.round(2700 * 1.15));
  // Потолок — цена лота до сбора аукциона, поэтому падает на доплату ÷ (1 + доля сбора).
  assert.ok(Math.abs(mainland.maxBidUsd - hawaii.maxBidUsd - 2700 / 1.035) <= 1);
  // Лот остаётся в расчёте с вердиктом, а не выбывает.
  assert.ok(['BUY', 'WATCH', 'SKIP'].includes(hawaii.verdict));
});

test('electric cars pay the ocean surcharge for batteries', () => {
  const petrol = calculateMaxBid(lot({ fuelType: 'Gasoline' }));
  const electric = calculateMaxBid(lot({ fuelType: 'Electric' }));
  assert.equal(electric.breakdown.evOceanSurchargeUsd, 300);
  assert.ok(electric.maxBidUsd < petrol.maxBidUsd);
});
