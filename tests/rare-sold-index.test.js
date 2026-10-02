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

  assert.deepEqual(fields, ["id", "soldAt", "salePrice", "source", "make", "model", "year", "mileage", "transmission", "color", "sold", "body", "engine", "drive", "trim", "generation", "resale", "flags"]);
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

test("points() carries the model line as «model» and the rest of the name as «trim», plus body, engine and drive", () => {
  const dir = tmpDir();
  const many = (model, n, extra = {}) => Array.from({ length: n }, (_, i) => lot(`${model}-${i}`, { model, ...extra }));
  const index = new SoldIndex([fakeScraper(dir, "a", [
    ...many("911 Turbo", 8, { bodyStyle: "Купе", cylinders: 6, engineLayout: "Оппозитный", drivetrain: "Полный" }),
    ...many("911 Carrera", 8),
    ...many("911 GT3", 4),
    lot("cc1", { model: "911 Turbo", trimName: "Turbo S" }),
  ])]);

  const { dict, rows } = index.points();
  const byId = Object.fromEntries(rows.map(row => [row[0], row]));
  const turbo = byId["911 Turbo-0"];

  assert.equal(dict.model[turbo[5]], "911");
  assert.equal(dict.trim[turbo[14]], "Turbo");
  assert.equal(dict.body[turbo[11]], "Купе");
  assert.equal(dict.engine[turbo[12]], "Оппозитный 6");
  assert.equal(dict.drive[turbo[13]], "Полный");
  assert.equal(dict.trim[byId.cc1[14]], "Turbo S"); // комплектация площадки (таксономия Collecting Cars) важнее догадки по названию
  assert.equal(byId["911 Carrera-0"][11], -1); // кузов не известен
});

test("comparables() narrows by trim, body, gearbox, engine, years and mileage, then relaxes from the end when there are too few", () => {
  const dir = tmpDir();
  const car = (id, o = {}) => lot(id, { model: "911 Turbo", year: 1996, bodyStyle: "Купе", transmissionKind: "manual", cylinders: 6, engineLayout: "Оппозитный", mileage: 30000, salePrice: 100000, ...o });
  const filler = Array.from({ length: 10 }, (_, i) => lot(`c${i}`, { model: "911 Carrera", year: 1996 }));
  const turbo = Array.from({ length: 4 }, (_, i) => car(`t${i}`, { salePrice: 100000 + i * 10000 }));
  const index = new SoldIndex([fakeScraper(dir, "a", [car("me", { salePrice: 125000 }), ...turbo, car("cab", { bodyStyle: "Кабриолет" }), car("auto", { transmissionKind: "automatic" }), car("far", { year: 2008 }), car("unsold", { sold: false }), ...filler, lot("other-make", { make: "Ferrari", model: "911 Turbo" })])]);

  const strict = index.comparables("me", { minCount: 3 });
  assert.equal(strict.line, "Porsche 911");
  assert.ok(strict.criteria.includes("Turbo") && strict.criteria.includes("Купе") && strict.criteria.includes("механика"));
  assert.deepEqual(strict.relaxed, []);
  assert.equal(strict.count, 4); // t0..t3: без кабриолета, автомата, далёкого года, непроданного, чужой марки
  assert.equal(strict.median, 110000);
  assert.equal(strict.lots.length, 4);
  assert.ok(strict.lots.every(l => l.id !== "me"));

  const relaxed = index.comparables("me", { minCount: 6 });
  assert.ok(relaxed.relaxed.length > 0); // мало равных — сняли самые слабые признаки и сказали об этом
  assert.ok(relaxed.criteria.includes("Turbo")); // комплектацию не снимаем никогда
  assert.ok(relaxed.relaxed.includes("близкий пробег") || relaxed.relaxed.some(label => /гг\./.test(label)));
  assert.equal(relaxed.thin, relaxed.count < 6);
  assert.ok(relaxed.lots.every(l => /Turbo/.test(String(l.model))) || relaxed.count === 0);

  assert.equal(index.comparables("nope"), null);
});

test("the same car sold more than once is grouped by VIN (or chassis number + make) and its history is returned oldest first", () => {
  const dir = tmpDir();
  const index = new SoldIndex([fakeScraper(dir, "a", [
    lot("v1", { vin: "WP0CD2A94RS257786", soldAt: "2022-03-01T00:00:00.000Z", salePrice: 150000 }),
    lot("v2", { vin: "WP0CD2A94RS257786", soldAt: "2025-05-01T00:00:00.000Z", salePrice: 190000, source: "RM Sotheby's" }),
    lot("other", { vin: "WP0CD2A94RS999999" }),
    lot("c1", { chassis: "164877D153201", make: "Chevrolet", soldAt: "2020-01-01T00:00:00.000Z" }),
    lot("c2", { chassis: "164877d 153201", make: "Chevrolet", soldAt: "2024-01-01T00:00:00.000Z" }),
    lot("c3", { chassis: "164877D153201", make: "Ford", soldAt: "2023-01-01T00:00:00.000Z" }), // тот же номер, другая марка — другая машина
    lot("short", { chassis: "A1" }),
    lot("short2", { chassis: "A1" }),
  ])]);

  assert.deepEqual(index.history("v2").map(l => l.id), ["v1", "v2"]);
  assert.deepEqual(index.history("v1").map(l => l.id), ["v1", "v2"]);
  assert.deepEqual(index.history("c2").map(l => l.id), ["c1", "c2"]);
  assert.deepEqual(index.history("other"), []);
  assert.deepEqual(index.history("c3"), []);
  assert.deepEqual(index.history("short"), []); // номер из двух знаков машину не определяет

  const { rows } = index.points();
  const byId = Object.fromEntries(rows.map(row => [row[0], row]));
  assert.equal(byId.v1[15 + 1], byId.v2[16]);
  assert.ok(byId.v1[16] >= 0);
  assert.equal(byId.other[16], -1);
});

test("comparables() never mixes modified or special-version cars with ordinary ones, and reports a thin sample instead of loosening that", () => {
  const dir = tmpDir();
  const car = (id, o = {}) => lot(id, { model: "911 Carrera 3.2", year: 1989, bodyStyle: "Тарга", mileage: 60000, salePrice: 50000, ...o });
  const index = new SoldIndex([fakeScraper(dir, "a", [
    car("me", { flags: ["special", "oneOwner"], mileage: 7944, salePrice: 357000 }),
    ...Array.from({ length: 12 }, (_, i) => car(`plain${i}`)),
    car("other-special", { flags: ["special"], salePrice: 300000 }),
    ...Array.from({ length: 5 }, (_, i) => car(`mod${i}`, { flags: ["modified"], salePrice: 90000 })),
  ])]);

  const comps = index.comparables("me", { minCount: 8 });
  assert.ok(comps.criteria.includes("особая версия"));
  assert.deepEqual(comps.lots.map(l => l.id), ["other-special"]); // обычные Carrera в сравнение не попали
  assert.equal(comps.thin, true);
  assert.equal(comps.median, 300000);

  const ordinary = index.comparables("plain0", { minCount: 8 });
  assert.ok(ordinary.criteria.includes("обычная версия"));
  assert.ok(ordinary.criteria.includes("серийные"));
  assert.ok(ordinary.lots.every(l => !(l.flags || []).length));
});

test("points() flags column packs modified/project/original/restored/one-owner/special and a computed low mileage", () => {
  const dir = tmpDir();
  const index = new SoldIndex([fakeScraper(dir, "a", [
    lot("f1", { flags: ["modified", "special"], year: 1989, mileage: 7944, soldAt: "2026-08-15T00:00:00.000Z" }),
    lot("f2", { year: 2024, mileage: 7944, soldAt: "2026-08-15T00:00:00.000Z" }),
  ])]);
  const byId = Object.fromEntries(index.points().rows.map(r => [r[0], r]));
  assert.equal(byId.f1[17], 1 + 32 + 64);
  assert.equal(byId.f2[17], 0);
});
