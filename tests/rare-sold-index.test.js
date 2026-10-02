const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SoldIndex, fullLot } = require("../src/rare/sold-index");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-sold-index-"));

/* Минимальный «сборщик»: файл архива + readSold/soldFile, как у настоящих. */
const fakeScraper = (dir, name, lots) => {
  const file = path.join(dir, `${name}.json`);
  const write = items => fs.writeFileSync(file, JSON.stringify(Object.fromEntries(items.map(lot => [lot.id, lot]))));
  write(lots);
  return {
    soldFile: () => file,
    readSold: () => Object.values(JSON.parse(fs.readFileSync(file, "utf8"))),
    write,
  };
};

const lot = (id, overrides = {}) => ({
  id,
  title: `Lot ${id}`,
  make: "Porsche",
  model: "911",
  year: 1992,
  source: "Bring a Trailer",
  sourceUrl: `https://example.com/${id}`,
  soldAt: "2026-03-10T12:00:00.000Z",
  salePrice: 100000,
  sold: true,
  mileage: 42000,
  transmissionKind: "manual",
  colorGroup: "Красный",
  photoUrl: "https://example.com/p.jpg",
  ...overrides,
});

test("points() returns compact rows with dictionaries instead of repeated strings", () => {
  const dir = tmpDir();
  const index = new SoldIndex([fakeScraper(dir, "a", [lot("a1"), lot("a2", { model: "Cayman", colorGroup: "Белый", transmissionKind: "automatic", mileage: null })])]);

  const { fields, dict, rows } = index.points();

  assert.deepEqual(fields, ["id", "soldAt", "salePrice", "source", "make", "model", "year", "mileage", "transmission", "color", "sold"]);
  assert.deepEqual(dict.model.sort(), ["911", "Cayman"]);
  assert.equal(rows.length, 2);

  const byId = Object.fromEntries(rows.map(row => [row[0], row]));
  assert.equal(byId.a1[1], Math.floor(Date.parse("2026-03-10T12:00:00.000Z") / 1000));
  assert.equal(byId.a1[2], 100000);
  assert.equal(dict.source[byId.a1[3]], "Bring a Trailer");
  assert.equal(dict.make[byId.a1[4]], "Porsche");
  assert.equal(byId.a1[6], 1992);
  assert.equal(byId.a1[7], 42000);
  assert.equal(byId.a1[8], 1); // механика
  assert.equal(dict.color[byId.a1[9]], "Красный");
  assert.equal(byId.a1[10], 1); // продан
  assert.equal(byId.a2[7], -1); // пробег неизвестен
  assert.equal(byId.a2[8], 2); // автомат
});

test("points() encodes unknown values as -1 / 0 and unsold as 0", () => {
  const dir = tmpDir();
  const index = new SoldIndex([fakeScraper(dir, "a", [lot("a1", { model: null, year: null, colorGroup: null, transmissionKind: undefined, sold: false })])]);

  const [row] = index.points().rows;
  assert.equal(row[5], -1);
  assert.equal(row[6], 0);
  assert.equal(row[8], 0);
  assert.equal(row[9], -1);
  assert.equal(row[10], 0);
});

test("points() honours since (inclusive) and until (exclusive) and sorts newest first", () => {
  const dir = tmpDir();
  const index = new SoldIndex([fakeScraper(dir, "a", [
    lot("old", { soldAt: "2024-01-01T00:00:00.000Z" }),
    lot("mid", { soldAt: "2025-06-01T00:00:00.000Z" }),
    lot("new", { soldAt: "2026-06-01T00:00:00.000Z" }),
  ])]);

  assert.deepEqual(index.points().rows.map(r => r[0]), ["new", "mid", "old"]);
  assert.deepEqual(index.points({ since: Date.parse("2025-06-01T00:00:00Z") }).rows.map(r => r[0]), ["new", "mid"]);
  assert.deepEqual(index.points({ since: Date.parse("2025-01-01T00:00:00Z"), until: Date.parse("2026-06-01T00:00:00Z") }).rows.map(r => r[0]), ["mid"]);
});

test("lotsByIds returns full lots with defaults filled in for old archive entries, skipping unknown ids", () => {
  const dir = tmpDir();
  const index = new SoldIndex([fakeScraper(dir, "a", [{ id: "old1", title: "Old", make: "Ford", source: "Hemmings", sourceUrl: "u", soldAt: "2025-01-01T00:00:00.000Z", salePrice: 5000 }])]);

  const [found, ...rest] = index.lotsByIds(["nope", "old1"]);
  assert.equal(rest.length, 0);
  assert.equal(found.id, "old1");
  assert.equal(found.mileage, null);
  assert.equal(found.exteriorColor, null);
  assert.deepEqual(found.conditionFacts, []);
  assert.equal(found.estimateMin, null);
  assert.equal(index.lot("missing"), null);
  assert.equal(index.lot("old1").title, "Old");
});

test("the index is rebuilt when an archive file changes, and merges several sources", () => {
  const dir = tmpDir();
  const a = fakeScraper(dir, "a", [lot("a1")]);
  const b = fakeScraper(dir, "b", [lot("b1", { source: "Hemmings" })]);
  const index = new SoldIndex([a, b]);

  assert.equal(index.total(), 2);

  a.write([lot("a1"), lot("a2")]);
  assert.equal(index.total(), 3);
});

test("lots without a date or price never enter the index", () => {
  const dir = tmpDir();
  const index = new SoldIndex([fakeScraper(dir, "a", [lot("ok"), lot("nodate", { soldAt: null }), lot("noprice", { salePrice: null })])]);
  assert.deepEqual(index.points().rows.map(r => r[0]), ["ok"]);
});

test("fullLot keeps what the archive already has", () => {
  assert.equal(fullLot({ id: "x", mileage: 10 }).mileage, 10);
});
