const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyExtraFilters, damageKind, hasExtraFilters } = require('../src/quick-search/extra-filters');
const { sanitizeFilters } = require('../src/quick-search/filters');

const NOW = Date.parse('2026-10-09T12:00:00Z');
const day = n => new Date(NOW + n * 24 * 3600 * 1000).toISOString();

const lots = [
  { lotNumber: 'a', seller: 'Geico', primaryDamage: '---', secondaryDamage: 'Hail', saleType: 'auction', saleDate: day(1) },
  { lotNumber: 'b', seller: '---', primaryDamage: '---', secondaryDamage: 'Rear end', saleType: 'fastBuy', saleDate: day(5) },
  { lotNumber: 'c', seller: 'Non-insurance Company', primaryDamage: 'Mechanical', secondaryDamage: '---', saleType: 'auction', saleDate: day(2) },
  { lotNumber: 'd', seller: 'Usaa', primaryDamage: '---', secondaryDamage: 'Minor dent/scratches', saleType: 'auction', saleDate: null },
  { lotNumber: 'e', seller: 'Usaa', primaryDamage: '---', secondaryDamage: 'Normal wear', secondaryDamage2: 'x', saleType: 'auction', saleDate: day(1) },
];

const ids = result => result.lots.map(lot => lot.lotNumber);

test('damage is split into impact and no impact; unknown text is neither', () => {
  assert.equal(damageKind(lots[0]), 'noImpact');
  assert.equal(damageKind(lots[1]), 'impact');
  assert.equal(damageKind(lots[2]), 'noImpact');
  assert.equal(damageKind({ primaryDamage: '---', secondaryDamage: '---' }), null);
  // Удар важнее износа.
  assert.equal(damageKind({ primaryDamage: 'Normal wear', secondaryDamage: 'Rear end' }), 'impact');
});

test('only the insurance seller keeps a lot; an unread dash does not pass', () => {
  assert.deepEqual(ids(applyExtraFilters(lots, { sellerMode: 'insurance' }, { now: NOW })), ['a', 'd', 'e']);
  // Продавец, найденный в истории, заменяет «---» из выдачи.
  const result = applyExtraFilters(lots, { sellerMode: 'insurance' }, { now: NOW, sellerOf: lot => lot.lotNumber === 'b' ? 'Progressive Casualty Insurance' : lot.seller });
  assert.deepEqual(ids(result), ['a', 'b', 'd', 'e']);
});

test('damage, sale type and the auction window work together', () => {
  assert.deepEqual(ids(applyExtraFilters(lots, { damageMode: 'noImpact' }, { now: NOW })), ['a', 'c', 'd', 'e']);
  assert.deepEqual(ids(applyExtraFilters(lots, { saleType: 'fastBuy' }, { now: NOW })), ['b']);
  // Окно 3 дня: лот без даты торгов и лот через 5 дней не проходят.
  assert.deepEqual(ids(applyExtraFilters(lots, { saleWindowDays: 3 }, { now: NOW })), ['a', 'c', 'e']);
  const together = applyExtraFilters(lots, { sellerMode: 'insurance', damageMode: 'noImpact', saleWindowDays: 3 }, { now: NOW });
  assert.deepEqual(ids(together), ['a', 'e']);
  assert.equal(together.dropped.seller, 2);
});

test('the form validates the new filters and drops unknown values', () => {
  const ok = sanitizeFilters({ make: 'Tesla', models: ['Model Y'], sellerMode: 'insurance', damageMode: 'noImpact', saleType: 'fastBuy', saleWindowDays: 3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.filters.sellerMode, 'insurance');
  assert.equal(ok.filters.saleWindowDays, 3);
  const junk = sanitizeFilters({ make: 'Tesla', models: ['Model Y'], sellerMode: 'any', damageMode: 'all', saleType: 'x' });
  assert.equal('sellerMode' in junk.filters, false);
  assert.equal(sanitizeFilters({ make: 'Tesla', models: ['Model Y'], saleWindowDays: 99 }).ok, false);
  assert.equal(hasExtraFilters({}), false);
  assert.equal(hasExtraFilters({ saleType: 'auction' }), true);
});
