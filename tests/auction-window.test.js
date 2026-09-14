const { test } = require('node:test');
const assert = require('node:assert/strict');
const { auctionWindow } = require('../src/providers/auction-window');

test('a lot stays in search through the auction day in Minsk and leaves the next day', () => {
  // Торги 15.09 в 16:30 по Минску.
  const car = { saleDate: '2026-09-15T13:30:00.000Z' };

  assert.equal(auctionWindow(car, new Date('2026-09-15T20:00:00.000Z')).over, false); // 23:00 по Минску
  assert.equal(auctionWindow(car, new Date('2026-09-15T21:30:00.000Z')).over, true); // 00:30 16.09 по Минску
  assert.equal(auctionWindow(car, new Date('2026-09-14T09:00:00.000Z')).over, false);
});

test('a lot without an auction date is kept but marked', () => {
  assert.deepEqual(auctionWindow({}, new Date('2026-09-20T00:00:00.000Z')), { over: false, saleDateConfirmed: false });
  assert.equal(auctionWindow({ saleDate: 'not a date' }).saleDateConfirmed, false);
});
