const { test } = require("node:test");
const assert = require("node:assert/strict");

const { computeMovement, rankMovement } = require("../src/rare/price-movement");

const NOW = Date.parse("2026-10-10T00:00:00Z");
const day = 86400_000;
const resolve = lot => ({ family: lot.family ?? "911", generation: lot.generation ?? "997.1", listed: true });

let n = 0;
const sale = (daysAgo, price, extra = {}) => ({ id: `s${n += 1}`, make: "Porsche", family: "911", generation: "997.1", year: 2007, source: "Bring a Trailer", country: "US", currency: "USD", sold: true, salePrice: price, soldAt: new Date(NOW - daysAgo * day).toISOString(), flags: [], ...extra });
const batch = (count, daysAgo, price, extra) => Array.from({ length: count }, (_, i) => sale(daysAgo + i, price, extra));

test("the change is the median of the last 12 months against the 12 before, with the number of sales on each side", () => {
  const lots = [...batch(25, 10, 60000), ...batch(25, 400, 50000)];
  const [item] = computeMovement(lots, resolve, { now: NOW });
  assert.equal(item.medianNow, 60000);
  assert.equal(item.medianPrev, 50000);
  assert.equal(item.change, 20);
  assert.equal(item.nNow, 25);
  assert.equal(item.nPrev, 25);
  assert.equal(item.confidence, "medium");
  assert.equal(item.ranked, true);
});

test("regions are never mixed: the same position in the US and in Great Britain is two separate rows", () => {
  const lots = [
    ...batch(25, 10, 60000), ...batch(25, 400, 50000),
    ...batch(22, 10, 90000, { country: "GB", currency: "GBP" }), ...batch(22, 400, 100000, { country: "GB", currency: "GBP" }),
  ];
  const items = computeMovement(lots, resolve, { now: NOW });
  const byRegion = Object.fromEntries(items.map(item => [item.region, item]));
  assert.equal(byRegion.US.change, 20);
  assert.equal(byRegion.GB.change, -10);
});

test("a position needs enough sales in both windows: 10–19 are shown as low confidence but not ranked, fewer are dropped", () => {
  const few = computeMovement([...batch(15, 10, 60000), ...batch(15, 400, 50000)], resolve, { now: NOW });
  assert.equal(few.length, 1);
  assert.equal(few[0].ranked, false);
  assert.equal(few[0].confidence, "low");
  assert.equal(computeMovement([...batch(25, 10, 60000), ...batch(5, 400, 50000)], resolve, { now: NOW }).length, 0);
});

test("only one platform is used per position — the one with the most sales in its weaker window", () => {
  const lots = [
    ...batch(30, 10, 60000), ...batch(30, 400, 50000),
    ...batch(12, 10, 99000, { source: "RM Sotheby's" }), ...batch(12, 400, 20000, { source: "RM Sotheby's" }),
  ];
  const [item] = computeMovement(lots, resolve, { now: NOW });
  assert.equal(item.source, "Bring a Trailer");
  assert.equal(item.change, 20);
});

test("modified cars, unsold lots and lots without a year or a price are left out", () => {
  const noise = [
    ...batch(40, 10, 500000, { flags: ["modified"] }), ...batch(40, 10, 1, { sold: false }),
    ...batch(40, 10, 500000, { year: null }), ...batch(40, 10, null),
  ];
  const lots = [...noise, ...batch(25, 10, 60000), ...batch(25, 400, 50000)];
  const [item] = computeMovement(lots, resolve, { now: NOW });
  assert.equal(item.nNow, 25);
  assert.equal(item.medianNow, 60000);
});

test("the ranking lists the biggest risers and fallers of one region and counts the rankable positions per region", () => {
  const lots = [];
  for (const [family, now, prev] of [["911", 70000, 50000], ["Corvette", 30000, 36000], ["Mustang", 26000, 26500]])
    lots.push(...batch(25, 10, now, { family }), ...batch(25, 400, prev, { family }));
  const items = computeMovement(lots, resolve, { now: NOW });
  const ranking = rankMovement(items, { region: "US", limit: 5 });
  assert.equal(ranking.rising[0].family, "911");
  assert.equal(ranking.rising[0].change, 40);
  assert.equal(ranking.falling[0].family, "Corvette");
  assert.equal(ranking.positions, 3);
  assert.equal(ranking.regions.find(region => region.id === "US").positions, 3);
  assert.equal(ranking.regions.find(region => region.id === "GB").positions, 0);
  assert.equal(ranking.rising[0].label, "Porsche 911 997.1");
});
