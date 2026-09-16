const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchTrim, possibleTrims } = require('../src/providers/trim-match');

const lot = (trim, extra = {}) => ({ year: 2017, make: 'Tesla', model: 'Model S', trim, ...extra });

test('the year-make-model prefix is not a trim', () => {
  assert.deepEqual(possibleTrims(lot('2017 Tesla Model S, 100D/60D/75D/90D...')).trims, ['100D', '60D', '75D', '90D']);
  assert.deepEqual(possibleTrims(lot('2018 Tesla MODEL S')).trims, []);
  assert.deepEqual(possibleTrims(lot('70D/85D/P85D')).trims, ['70D', '85D', 'P85D']);
});

test('a trim among possible ones matches without confirmation', () => {
  assert.equal(matchTrim(lot('2017 Tesla Model S, 100D/60D/75D/90D...'), ['100D']).status, 'possible');
  assert.equal(matchTrim(lot('2016 Tesla Model X, 75D/P100D/P90D'), ['100D', 'P100D', 'Plaid']).status, 'possible');
  assert.equal(matchTrim(lot('Long Range/Perfo...', { trimTruncated: true }), ['Performance']).status, 'possible');
});

test('a single visible trim confirms, a different full list rejects', () => {
  assert.equal(matchTrim(lot('2023 Tesla Model X, Plaid Tri Motor...'), ['Plaid']).status, 'confirmed');
  assert.equal(matchTrim(lot('2015 Tesla MODEL S, 85D'), ['85D']).status, 'confirmed');
  assert.equal(matchTrim(lot('2015 Tesla Model S, 70D/85D/P85D'), ['100D']).status, 'mismatch');
  // P100D — не 100D.
  assert.equal(matchTrim(lot('P100D'), ['100D']).status, 'mismatch');
});

test('no trim data, or a list cut before the wanted trim, is unknown', () => {
  assert.equal(matchTrim(lot('2018 Tesla MODEL S'), ['100D']).status, 'unknown');
  assert.equal(matchTrim(lot(null), ['100D']).status, 'unknown');
  assert.equal(matchTrim(lot('60D/70D/75D/90D/...', { trimTruncated: true }), ['100D']).status, 'unknown');
});

test('a truncated trim tail is not shown to a person as a stub', () => {
  const { trimLabels } = require('../src/providers/trim-match');

  assert.deepEqual(trimLabels(lot('100D/75D/Long Ra...', { trimTruncated: true })), ['100D', '75D']);
  assert.deepEqual(trimLabels(lot('Long Range Dual...', { trimTruncated: true })), ['Long Range']);
  assert.deepEqual(matchTrim(lot('100D/75D/Long Ra...', { trimTruncated: true }), ['100D']).possible, ['100D', '75D']);
});
