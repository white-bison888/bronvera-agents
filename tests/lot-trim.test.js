const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readTrimFromPage, tidyTrim, trimFromListing } = require('../src/providers/lot-trim');

test('the trim is read from the lot page header and tidied', () => {
  const page = 'Search\n2021 TESLA MODEL 3, STANDARD RANGE PLUS REAR-WHEEL DRIVE 5YJ3E1EA8MF041540 IAAI\nLocation: Metro DC';
  assert.equal(readTrimFromPage(page), 'Standard Range Plus Rear-Wheel Drive');
  assert.equal(readTrimFromPage('2026 TESLA MODEL Y, PREMIUM REAR-WHEEL DRIVE/REAR-WHEEL DRIVE\n7SAYGDED3TA601295'), 'Premium Rear-Wheel Drive/Rear-Wheel Drive');
});

test('a lot page without a trim gives nothing, not a guess', () => {
  assert.equal(readTrimFromPage('2024 TESLA MODEL Y\n7SAYGDED5RF088143 Copart'), null);
});

test('a truncated or empty trim in search results is not used', () => {
  assert.equal(trimFromListing('2021 Tesla Model 3, Long Range Dual...'), null);
  assert.equal(trimFromListing('2022 Tesla MODEL 3'), null);
  assert.equal(trimFromListing('2023 Tesla Model 3, Rear-Wheel Drive'), 'Rear-Wheel Drive');
});

test('trim codes like 100D/P85 stay as they are', () => {
  assert.equal(tidyTrim('70D/85D/P85D'), '70D/85D/P85D');
});
