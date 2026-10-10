const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSeller, pickSeller } = require('../src/providers/lot-requirements');

test('the seller kind tells insurance, other, unpublished and unread apart', () => {
  assert.equal(checkSeller('Geico').kind, 'insurance');
  assert.equal(checkSeller('Non-insurance Company').kind, 'other');
  assert.equal(checkSeller('Hertz').kind, 'other');
  assert.equal(checkSeller('No information').kind, 'unpublished');
  assert.equal(checkSeller('---').kind, 'unread');
  assert.equal(checkSeller('').kind, 'unread');
});

test('pickSeller prefers a known seller, then the lot page "No information", never the catalog dash', () => {
  assert.equal(pickSeller(['---', 'No information', 'Usaa']), 'Usaa');
  assert.equal(pickSeller(['---', 'No information']), 'No information');
  assert.equal(pickSeller(['---', undefined, '']), '---');
  assert.equal(pickSeller([undefined, '']), undefined);
});
