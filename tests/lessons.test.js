const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pairs, assessorLesson, selectorLesson, marketAnalystLesson, median } = require('../src/lessons/build-lessons');

// Запись истории: нам нужны только потолок, факт продажи и откуда взят ремонт.
const row = (cap, sold, extra = {}) => ({
  maxBidUsd: cap,
  actual: { soldPriceUsd: sold },
  repairCostSource: 'photo',
  decision: 'WATCH',
  marketValueUsd: 30000,
  ...extra,
});

const many = (n, build) => Array.from({ length: n }, (_, i) => build(i));

test('only records with both a ceiling and a real sale price become pairs', () => {
  const history = [
    row(10000, 12000),
    { maxBidUsd: 10000 },                                  // факта нет
    { actual: { soldPriceUsd: 12000 } },                   // потолка нет
    { maxBidUsd: 0, actual: { soldPriceUsd: 12000 } },     // потолок нулевой
    { maxBidUsd: 10000, actual: { soldPriceUsd: 0 } },     // продажи не было
  ];
  const result = pairs(history);
  assert.equal(result.length, 1);
  assert.equal(result[0].gap, 0.2);
  assert.equal(result[0].winnable, false);
});

test('a lot sold at or below the ceiling counts as winnable', () => {
  assert.equal(pairs([row(10000, 10000)])[0].winnable, true);
  assert.equal(pairs([row(10000, 9000)])[0].winnable, true);
  assert.equal(pairs([row(10000, 10001)])[0].winnable, false);
});

test('a source with fewer than ten lots teaches nothing', () => {
  const thin = pairs(many(9, () => row(10000, 13000)));
  assert.equal(assessorLesson(thin), null);
  assert.equal(selectorLesson(thin), null);
  assert.equal(marketAnalystLesson(thin), null);
});

test('the normative repair estimate is called out when it misses far wider', () => {
  const history = [
    ...many(12, () => row(10000, 11000)),                                   // photo: +10%
    ...many(12, () => row(10000, 20000, { repairCostSource: 'norm' })),     // norm: +100%
  ];
  const lesson = assessorLesson(pairs(history));
  assert.match(lesson, /photo/);
  assert.match(lesson, /norm/);
  assert.match(lesson, /Типовой норматив ненадёжен/);
  assert.match(lesson, /больше в 10 раз/);
  // Промах выражен как «дороже нашей предельной», без противоречивых «+10% ниже».
  assert.match(lesson, /\+10% дороже нашей предельной цены \(12 лотов\)/);
  assert.doesNotMatch(lesson, /% ниже/);
});

test('sources that miss by a similar amount get no scolding line', () => {
  const history = [
    ...many(12, () => row(10000, 11000)),
    ...many(12, () => row(10000, 11200, { repairCostSource: 'norm' })),
  ];
  assert.doesNotMatch(assessorLesson(pairs(history)), /ненадёжен/);
});

test('the selector lesson reports the winnable share and singles out BUY', () => {
  const history = [
    ...many(10, () => row(10000, 9000, { decision: 'BUY' })),   // взяли бы все 10
    ...many(10, () => row(10000, 20000)),                       // рынок ушёл выше
  ];
  const lesson = selectorLesson(pairs(history));
  assert.match(lesson, /прошли бы 10 — это 50%/);
  assert.match(lesson, /BUY/);
});

test('the market lesson gives the auction-to-Belarus ratio', () => {
  const history = many(12, () => row(10000, 15000, { marketValueUsd: 30000 }));
  assert.match(marketAnalystLesson(pairs(history)), /составляла 50% от цены целого аналога/);
});

test('median handles both odd and even counts and an empty list', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});
