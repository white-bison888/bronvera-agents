const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lotWarnings, noticeFields, readLotNotices } = require('../src/providers/lot-notices');
const { calculateMaxBid } = require('../src/economics/max-bid');

// Тексты плашек со страниц лотов 0-45641447 и 1-67538336 (скриншоты Mikita, 15.09.2026).
const hawaiiPage = `Sales History 3
Information! Bidding on electric and hybrid vehicles from Hawaii is not possible due to restrictions imposed by carriers operating on the Hawaii to mainland United States route.
Hide information
Lot 0-45641447`;

const flipPage = `Information! This vehicle was sold at another auction
January 27, 2026.
Hide information View previous auction
Seller
Non-insurance Company
Your available bidding power has been exceeded.
Bidding on this vehicle has been disabled because BidCars does not recommend it. You can enable bidding here.
Patryk Szwałek Bidcars Expert
Not recommended by BidCars!
This vehicle is most likely a "flip", meaning it was bought at auction and is being resold.`;

test('bid.cars banners are read from the lot page text', () => {
  const hawaii = readLotNotices(hawaiiPage);
  assert.match(hawaii.biddingRestricted, /^Bidding on electric and hybrid vehicles from Hawaii is not possible/);
  assert.equal(hawaii.notices.length, 1);
  assert.equal(hawaii.notRecommended, null);

  const flip = readLotNotices(flipPage);
  assert.equal(flip.biddingRestricted, null);
  assert.equal(flip.soldBefore, 'January 27, 2026');
  assert.match(flip.biddingDisabledByBidCars, /does not recommend it/);
  assert.match(flip.notRecommended, /most likely a "flip"/);
  assert.deepEqual(flip.notices, ['This vehicle was sold at another auction January 27, 2026.']);

  assert.deepEqual(readLotNotices('Lot 1-1 Seller Geico'), {
    notices: [], biddingRestricted: null, biddingDisabledByBidCars: null, notRecommended: null, soldBefore: null,
  });
});

test('a Hawaii EV is marked not biddable before anyone opens its page; banners become warnings', () => {
  const insurer = { seller: 'Geico' };
  assert.equal(lotWarnings({ ...insurer, make: 'Tesla', location: 'Honolulu (HI)' }).biddable, false);
  assert.equal(lotWarnings({ ...insurer, fuelType: 'Gasoline', location: 'Honolulu (HI)' }).biddable, true);
  assert.equal(lotWarnings({ ...insurer, make: 'Tesla', location: 'Culpeper (VA)' }).warnings.length, 0);

  const flip = lotWarnings({ seller: 'Non-insurance Company', ...noticeFields(readLotNotices(flipPage)) });
  assert.equal(flip.biddable, true);
  assert.equal(flip.warnings.length, 3);

  const page = lotWarnings({ ...insurer, ...noticeFields(readLotNotices(hawaiiPage)), make: 'Tesla', location: 'Honolulu (HI)' });
  assert.equal(page.warnings.length, 1);
  assert.match(page.warnings[0], /from Hawaii is not possible/);
});

test('an unknown seller is kept but marked: not given by bid.cars vs not read yet', () => {
  const [none] = lotWarnings({ seller: 'No information' }).warnings;
  assert.match(none, /не указан \(No information\)/);

  for (const seller of ['---', '', undefined])
    assert.match(lotWarnings({ seller }).warnings[0], /ещё не проверен на странице лота/);

  assert.deepEqual(lotWarnings({ seller: 'State Farm Group Insurance' }).warnings, []);

  // Пометка не меняет расчёт: лот с неизвестным продавцом по-прежнему получает потолок.
  const result = calculateMaxBid({
    seller: 'No information', year: 2023, marketValueUsd: 26000,
    photoAssessment: { available: true, repairCostMin: 1000, repairCostMax: 2000 },
  });
  assert.ok(Number.isFinite(result.maxBidUsd));
  assert.match(result.warnings.at(-1), /No information/);
});

test('the deal is still calculated for a restricted lot — it is marked, not dropped', () => {
  const result = calculateMaxBid({
    lotNumber: '0-45641447', make: 'Tesla', fuelType: 'Electric', location: 'Honolulu (HI)', year: 2021,
    marketValueUsd: 27500, auctionEstimateMin: 2650, auctionEstimateMax: 5225,
    photoAssessment: { available: true, repairCostMin: 1300, repairCostMax: 2200 },
  });

  assert.equal(result.biddable, false);
  assert.ok(Number.isFinite(result.maxBidUsd));
  assert.ok(['BUY', 'WATCH', 'SKIP'].includes(result.verdict));
  assert.match(result.warnings[0], /Ставка через bid.cars недоступна/);

  // Нестраховой продавец по-прежнему даёт отказ — и тоже с предупреждениями.
  const skipped = calculateMaxBid({ seller: 'Non-insurance Company', ...noticeFields(readLotNotices(flipPage)) });
  assert.equal(skipped.verdict, 'SKIP');
  assert.equal(skipped.warnings.length, 3);
});
