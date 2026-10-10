const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateMaxBid, importTaxesBYIndividual, auctionFeeFn } = require('../src/economics/max-bid');

const year = new Date().getFullYear();
const photoAssessment = { available: true, repairCostMin: 2000, repairCostMax: 4000, photosAnalyzed: 12 };
// Продавец прочитан: до вердикта лот доходит только после визита на страницу лота.
const lot = (extra = {}) => ({ lotNumber: 'L', year: year - 2, marketValueUsd: 30000, seller: 'State Farm Group Insurance', photoAssessment, ...extra });

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
  // Непрочитанный продавец — ожидание, а не разрешение: ни вердикта, ни потолка.
  const unread = calculateMaxBid(lot({ seller: '-' }));
  assert.equal(unread.verdict, 'PENDING_SELLER');
  assert.equal(unread.maxBidUsd, null);
  assert.match(unread.reason, /продавец не указан/);
  // Утренний отбор — предварительная очередь: там расчёт идёт и без продавца.
  assert.notEqual(calculateMaxBid(lot({ seller: '-' }), { requireKnownSeller: false }).maxBidUsd, null);
});

test('lots in Hawaii and Alaska pay a long inland leg from the port table, Puerto Rico keeps its surcharge, none is dropped', () => {
  const forecast = { auctionEstimateMin: 3000, auctionEstimateMax: 5000 };
  const mainland = calculateMaxBid(lot({ ...forecast, location: 'Culpeper (VA)' }));
  const hawaii = calculateMaxBid(lot({ ...forecast, location: 'Honolulu (HI)' }));
  const alaska = calculateMaxBid(lot({ ...forecast, location: 'Anchorage (AK)' }));
  const puertoRico = calculateMaxBid(lot({ ...forecast, location: 'San Juan (PR)' }));

  assert.equal(mainland.breakdown.remoteLocationSurchargeUsd, 0);
  // Гавайи и Аляска: перегон уже в таблице штатов (1 765 $ и 3 025 $), отдельной доплаты нет.
  assert.equal(hawaii.breakdown.usTransportUsd, 1765);
  assert.equal(alaska.breakdown.usTransportUsd, 3025);
  assert.equal(hawaii.breakdown.remoteLocationSurchargeUsd, 0);
  assert.equal(alaska.breakdown.remoteLocationSurchargeUsd, 0);
  // Пуэрто-Рико в таблице нет — прежние общие ставки и доплата.
  assert.equal(puertoRico.breakdown.remoteLocationSurchargeUsd, 1300);
  assert.equal(puertoRico.assumptions.remoteLocation, 'PR');
  assert.deepEqual(puertoRico.assumptions.logistics, { source: 'default' });

  // Дороже материка, но лот остаётся в расчёте с вердиктом.
  assert.ok(hawaii.profit.atExpectedUsd < mainland.profit.atExpectedUsd);
  assert.ok(hawaii.maxBidUsd < mainland.maxBidUsd);
  assert.ok(['BUY', 'WATCH', 'SKIP'].includes(hawaii.verdict));
});

test('logistics follow the pickup state: port, inland leg and sea freight differ', () => {
  const calc = location => calculateMaxBid(lot({ auctionEstimateMin: 3000, auctionEstimateMax: 5000, location })).breakdown;
  const baltimore = calc('Baltimore (MD)');
  const atlanta = calc('Atlanta North (GA)');
  const losAngeles = calc('Los Angeles (CA)');

  // westmotors.by 07.10.2026: Балтимор → Нью-Йорк $425 и море $1 350; Атланта → Саванна $400 и $1 325; Лос-Анджелес $300 и $1 850.
  assert.equal(baltimore.usTransportUsd, 425);
  assert.equal(baltimore.oceanFreightUsd, 1350);
  assert.equal(atlanta.usTransportUsd, 400);
  assert.equal(atlanta.oceanFreightUsd, 1325);
  assert.equal(losAngeles.usTransportUsd, 300);
  assert.equal(losAngeles.oceanFreightUsd, 1850);
});

test('an unknown state or explicit rates fall back to the common rates', () => {
  const unknown = calculateMaxBid(lot({ auctionEstimateMin: 3000, auctionEstimateMax: 5000, location: 'Somewhere' })).breakdown;
  assert.equal(unknown.usTransportUsd, 500);
  assert.equal(unknown.oceanFreightUsd, 995);
  const explicit = calculateMaxBid(lot({ auctionEstimateMin: 3000, auctionEstimateMax: 5000, location: 'Baltimore (MD)' }), { oceanFreightUsd: 2000 }).breakdown;
  assert.equal(explicit.oceanFreightUsd, 2000);
});

test('electric cars pay the ocean surcharge for batteries', () => {
  // Бензину для расчёта в Беларуси нужен объём двигателя — пошлина физлица зависит от него.
  const petrol = calculateMaxBid(lot({ fuelType: 'Gasoline', displacementL: 2.0 }));
  const electric = calculateMaxBid(lot({ fuelType: 'Electric' }));
  assert.equal(electric.breakdown.evOceanSurchargeUsd, 300);
  assert.equal(petrol.breakdown.evOceanSurchargeUsd, 0);
});

test('a lot with photos and a price but an unread seller waits instead of becoming a candidate', () => {
  /*
   * Так 19.09 прошёл лот 1-64403346: снимки собраны, цена в Беларуси есть,
   * прогноз попадает под потолок — и «Перспективный», хотя на странице лота
   * продавец Non-insurance Company, который мы просто не дочитали.
   */
  const promising = calculateMaxBid(lot({ auctionEstimateMin: 4000, auctionEstimateMax: 6000 }));

  assert.equal(promising.verdict, 'BUY');

  // С 09.10: «No information» — страницу лота прочитали, площадка продавца не публикует; лот оценивается с пометкой.
  const unpublished = calculateMaxBid(lot({ seller: 'No information', auctionEstimateMin: 4000, auctionEstimateMax: 6000 }));

  assert.equal(unpublished.verdict, 'BUY');
  assert.ok(unpublished.warnings.some(text => /не указан/.test(text)));

  for (const seller of ['---', '', undefined]) {
    const waiting = calculateMaxBid(lot({ seller, auctionEstimateMin: 4000, auctionEstimateMax: 6000 }));

    assert.equal(waiting.verdict, 'PENDING_SELLER');
    assert.equal(waiting.maxBidUsd, null);
    assert.equal(waiting.viable, false);
  }

  // Известный нестраховой продавец — окончательный отказ, а не ожидание.
  assert.equal(calculateMaxBid(lot({ seller: 'Non-insurance Company', auctionEstimateMin: 4000, auctionEstimateMax: 6000 })).verdict, 'SKIP');
});


/*
 * Бензин и дизель в Беларусь как физлицо: точки из официального калькулятора ГТК
 * (customs.gov.by/calc), сверенные с autogood.by 07.10.2026. Пошлина в евро.
 */
const rates = require('../src/economics/rates');
const toEur = rates.bynPerUsd / rates.bynPerEur;
const taxesFor = (year, displacementL) => importTaxesBYIndividual({ year, displacementL, fuelType: 'Gasoline' }, rates, new Date('2026-10-07'));

test('3–5 years: duty only by engine size, same as the customs calculator', () => {
  // 2023 → 3 года: 3000 см³ → 3,0 €/см³ = 9 000 €; 1500 см³ → 1,7 €/см³ = 2 550 €.
  assert.ok(Math.abs(taxesFor(2023, 3.0).dutyFn(1) * toEur - 9000) < 0.01);
  assert.ok(Math.abs(taxesFor(2023, 1.5).dutyFn(50000) * toEur - 2550) < 0.01);
  assert.ok(Math.abs(taxesFor(2023, 3.5).dutyFn(1) * toEur - 12600) < 0.01);
});

test('older than 5 years: the higher per-cm³ table', () => {
  assert.ok(Math.abs(taxesFor(2019, 1.8).dutyFn(1) * toEur - 6300) < 0.01);
  assert.ok(Math.abs(taxesFor(2019, 3.5).dutyFn(1) * toEur - 19950) < 0.01);
});

test('under 3 years: the larger of a share of the value and the per-cm³ rate, by value bracket', () => {
  const duty = (year, volume, eur) => taxesFor(year, volume).dutyFn(eur / toEur) * toEur;
  // 10 000 €, 2000 см³: 48% = 4 800 < 3,5×2000 = 7 000.
  assert.ok(Math.abs(duty(2025, 2.0, 10000) - 7000) < 0.01);
  // 10 000 €, 1000 см³: 48% = 4 800 > 3 500.
  assert.ok(Math.abs(duty(2025, 1.0, 10000) - 4800) < 0.01);
  // 8 000 € — первая ступень: 54% = 4 320.
  assert.ok(Math.abs(duty(2025, 1.5, 8000) - 4320) < 0.01);
  // 60 000 €, 4000 см³: 48% = 28 800 < 7,5×4000 = 30 000.
  assert.ok(Math.abs(duty(2025, 4.0, 60000) - 30000) < 0.01);
});

test('the physical-person utilization fee is flat and depends only on age; there is no VAT', () => {
  assert.ok(Math.abs(taxesFor(2025, 5.0).recyclingFeeUsd * rates.bynPerUsd - 624.92) < 0.001);
  assert.ok(Math.abs(taxesFor(2022, 1.5).recyclingFeeUsd * rates.bynPerUsd - 1282.02) < 0.001);
  assert.equal(taxesFor(2022, 1.5).vatRate, 0);
});

test('model-year boundaries are flagged, and a missing engine size gives no verdict', () => {
  assert.equal(taxesFor(2023, 2.0).ageBorderline, true);
  assert.equal(taxesFor(2021, 2.0).ageBorderline, true);
  assert.equal(taxesFor(2024, 2.0).ageBorderline, false);
  assert.equal(taxesFor(2023, null), null);
  const result = calculateMaxBid(lot({ fuelType: 'Gasoline' }));
  assert.equal(result.verdict, 'NEEDS_ENGINE_DATA');
  assert.equal(result.maxBidUsd, null);
});

test('for a big petrol engine the ceiling is lower than for a small one, found by bisection', () => {
  const small = calculateMaxBid(lot({ fuelType: 'Gasoline', displacementL: 1.6, year: 2022 }));
  const large = calculateMaxBid(lot({ fuelType: 'Gasoline', displacementL: 5.0, year: 2022 }));
  assert.ok(large.maxBidUsd < small.maxBidUsd);
  assert.equal(large.assumptions.scheme, 'physical');
});


/*
 * Сбор аукциона по таблице westmotors.by (07.10.2026): точки Copart, IAAI дороже на $10.
 */
test('the auction fee follows the table: exact at its points, linear between, 6% above the last', () => {
  const rates = require('../src/economics/rates');
  const fee = (price, auction = 'Copart') => auctionFeeFn({ auction }, rates, {}).fee(price);

  assert.equal(fee(500), 460);
  assert.equal(fee(5000), 1025);
  assert.equal(fee(10000), 1260);
  assert.equal(fee(20000), 1610);
  assert.equal(fee(50000), 3410);
  // Между 5 000 и 7 500: 1 025 → 1 170, середина — 1 097,5.
  assert.equal(fee(6250), 1097.5);
  // Выше последней точки — 6% от прироста цены.
  assert.equal(fee(60000), 3410 + 600);
  // Ниже первой — первая сумма, без деления на ноль.
  assert.equal(fee(0), 335);
  assert.equal(fee(10000, 'IAAI'), 1270);
});

test('explicit fee rates in the call switch back to the old straight line', () => {
  const rates = require('../src/economics/rates');
  const { fee, linear } = auctionFeeFn({}, rates, { auctionFeeRate: 0.035, auctionFeeFixed: 780 });
  assert.equal(linear, true);
  assert.equal(fee(10000), 1130);
});

test('the ceiling with the table fee still leaves exactly the minimum profit', () => {
  const result = calculateMaxBid(lot({ auctionEstimateMin: 8000, auctionEstimateMax: 12000, location: 'Baltimore (MD)' }));
  assert.equal(result.assumptions.auctionFee, 'table');
  const atCeiling = calculateMaxBid(lot({ auctionEstimateMin: result.maxBidUsd, auctionEstimateMax: result.maxBidUsd, location: 'Baltimore (MD)' }));
  assert.ok(Math.abs(atCeiling.profit.atExpectedUsd - 2000) <= 3);
});
