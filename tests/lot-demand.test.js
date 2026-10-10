const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addPoint, demandOf, readViews } = require('../src/providers/lot-demand');

const at = minutes => new Date(Date.UTC(2026, 9, 7, 12, 0) + minutes * 60000).toISOString();

test('views are read from the lot page text', () => {
  assert.equal(readViews('Lot 77 people viewed this vehicle Watch'), 77);
  assert.equal(readViews('1,204 people viewed this vehicle'), 1204);
  assert.equal(readViews('нет счётчика'), null);
});

test('a counter that goes down is a misread and is dropped', () => {
  const history = addPoint(addPoint([], 80, at(0)), 70, at(10));
  assert.deepEqual(history.map(p => p.views), [80]);
});

test('one reading gives views only, marked preliminary', () => {
  const demand = demandOf(addPoint([], 77, at(0)));
  assert.equal(demand.views, 77);
  assert.equal(demand.perHour, null);
  assert.equal(demand.preliminary, true);
  assert.equal(demand.level, 'normal');
});

test('fast growth is high demand, a stalled low counter is low demand', () => {
  const fast = [{ views: 60, at: at(0) }, { views: 100, at: at(120) }];
  assert.equal(demandOf(fast).perHour, 20);
  assert.equal(demandOf(fast).level, 'high');

  const quiet = [{ views: 12, at: at(0) }, { views: 12, at: at(120) }];
  assert.equal(demandOf(quiet).level, 'low');

  const many = [{ views: 200, at: at(0) }];
  assert.equal(demandOf(many).level, 'high');
});

test('readings older than the window are not used for the growth rate', () => {
  const demand = demandOf([{ views: 10, at: at(0) }, { views: 50, at: at(600) }, { views: 52, at: at(660) }]);
  assert.equal(demand.perHour, 2);
  assert.equal(demand.grownInWindow, 2);
});
