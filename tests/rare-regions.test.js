const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeCountry, regionOfCountry, regionOf, REGIONS } = require("../src/rare/regions");

test("a country comes out as an ISO code from codes and from common English names", () => {
  assert.equal(normalizeCountry("us"), "US");
  assert.equal(normalizeCountry("UK"), "GB");
  assert.equal(normalizeCountry("United Kingdom"), "GB");
  assert.equal(normalizeCountry("Switzerland"), "CH");
  assert.equal(normalizeCountry(""), null);
  assert.equal(normalizeCountry("Atlantis"), null);
  assert.equal(normalizeCountry(null), null);
});

test("countries fall into the seven sale regions, with all of continental Europe as one", () => {
  assert.equal(regionOfCountry("US"), "US");
  assert.equal(regionOfCountry("GB"), "GB");
  assert.equal(regionOfCountry("DE"), "EU");
  assert.equal(regionOfCountry("CH"), "EU");
  assert.equal(regionOfCountry("MC"), "EU");
  assert.equal(regionOfCountry("NZ"), "AU");
  assert.equal(regionOfCountry("JP"), "JP");
  assert.equal(regionOfCountry("BR"), "OTHER");
  assert.equal(regionOfCountry(null), null);
  assert.equal(REGIONS.length, 7);
});

test("regionOf prefers the named country over the currency and says which one it used", () => {
  assert.deepEqual(regionOf({ country: "FR", currency: "USD" }), { country: "FR", region: "EU", basis: "country" });
  assert.deepEqual(regionOf({ currency: "GBP" }), { country: "GB", region: "GB", basis: "currency" });
  assert.deepEqual(regionOf({}), { country: "US", region: "US", basis: "currency" });
  assert.deepEqual(regionOf({ currency: "XXX" }), { country: null, region: null, basis: null });
});
