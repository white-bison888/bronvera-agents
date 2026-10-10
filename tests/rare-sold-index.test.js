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

  assert.deepEqual(fields, ["id", "soldAt", "salePrice", "source", "make", "model", "year", "mileage", "transmission", "color", "sold", "body", "engine", "drive", "trim", "generation", "resale", "flags", "region"]);
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

const car = (id, o = {}) => lot(id, { model: "911 Carrera 3.2", year: 1989, bodyStyle: "Тарга", transmissionKind: "manual", cylinders: 6, engineLayout: "Оппозитный", mileage: 60000, salePrice: 50000, ...o });
const ids = list => list.map(l => l.id);

test("comparables() shows only the same cars when there are enough of them, and says nothing about differences", () => {
  const index = new SoldIndex([fakeScraper(tmpDir(), "a", [
    car("me", { salePrice: 60000 }),
    ...Array.from({ length: 6 }, (_, i) => car(`same${i}`, { year: 1988 + (i % 3), salePrice: 50000 + i * 1000 })),
    car("cab", { bodyStyle: "Кабриолет" }),
    car("auto", { transmissionKind: "automatic" }),
    car("old", { year: 1975 }),
    car("unsold", { sold: false }),
    lot("ferrari", { make: "Ferrari", model: "911 Carrera 3.2" }),
  ])]);

  const comps = index.comparables("me");
  assert.equal(comps.basis, "exact");
  assert.equal(comps.exactCount, 6);
  assert.deepEqual(ids(comps.lots).sort(), ["same0", "same1", "same2", "same3", "same4", "same5"]);
  assert.ok(comps.lots.every(l => l.similarity === "exact" && l.differs.length === 0));
  assert.equal(comps.thin, false);
  assert.equal(comps.median, 52000);
});

test("comparables() adds the nearest cars by class and age when there are few identical ones, and labels how each differs", () => {
  // Поколение берётся из справочника (по годам): 2012–2015 — 991.1, 2020 — 992.1, 1990 — 964.
  const c = (id, o = {}) => car(id, { model: "911 Carrera", ...o });
  const index = new SoldIndex([fakeScraper(tmpDir(), "a", [
    c("me", { year: 2014 }),
    c("twin", { year: 2014, salePrice: 90000 }),
    c("gen992", { year: 2020, salePrice: 150000 }),
    c("near-year", { year: 2015, transmissionKind: "automatic", salePrice: 95000 }),
    c("far", { year: 1990, salePrice: 40000 }),
    ...Array.from({ length: 4 }, (_, i) => c(`other${i}`, { year: 2012 + i, bodyStyle: "Купе", salePrice: 70000 + i })),
  ])]);

  const comps = index.comparables("me");
  assert.equal(comps.basis, "nearest");
  assert.equal(comps.exactCount, 1);
  assert.equal(comps.lots[0].id, "twin");
  assert.equal(comps.lots[0].similarity, "exact");
  assert.equal(comps.thin, true);

  const byId = Object.fromEntries(comps.lots.map(l => [l.id, l]));
  assert.equal(byId["near-year"].similarity, "near");
  assert.ok(byId["near-year"].differs.includes("автомат"));
  assert.ok(byId.gen992.differs.includes("поколение 992.1"));
  assert.ok(byId.other0.differs.includes("кузов: Купе"));
  // ближайшие идут раньше далёких: машина 1990 года и другого поколения — в самом конце
  const order = ids(comps.lots);
  assert.ok(order.indexOf("near-year") < order.indexOf("far") || !order.includes("far"));
});

test("comparables() never mixes modified cars with stock ones; special versions come first and ordinary cars are only a labelled fallback", () => {
  const index = new SoldIndex([fakeScraper(tmpDir(), "a", [
    car("me", { flags: ["special", "oneOwner"], mileage: 7944, salePrice: 357000 }),
    ...Array.from({ length: 12 }, (_, i) => car(`plain${i}`)),
    car("other-special", { flags: ["special"], salePrice: 300000 }),
    ...Array.from({ length: 5 }, (_, i) => car(`mod${i}`, { flags: ["modified"], salePrice: 90000 })),
  ])]);

  const comps = index.comparables("me");
  assert.equal(comps.lots[0].id, "other-special");
  assert.equal(comps.lots[0].similarity, "exact");
  assert.equal(comps.basis, "nearest");
  assert.ok(!ids(comps.lots).some(id => id.startsWith("mod"))); // доработанные — никогда
  const plain = comps.lots.find(l => l.id.startsWith("plain"));
  assert.equal(plain.similarity, "near");
  assert.ok(plain.differs.includes("обычная версия"));

  const ordinary = index.comparables("plain0");
  assert.ok(ordinary.criteria.includes("серийные"));
  assert.ok(ordinary.lots.every(l => !(l.flags || []).includes("modified")));
});

test("comparables() treats '50th Anniversary Edition' and '50th Anniversary Edition - Manual' as the same trim", () => {
  const index = new SoldIndex([fakeScraper(tmpDir(), "a", [
    car("me", { model: "911 50th Anniversary Edition", trimName: "50th Anniversary Edition", generation: "991.1", year: 2014 }),
    ...Array.from({ length: 5 }, (_, i) => car(`ann${i}`, { model: "911 50th Anniversary Edition", trimName: "50th Anniversary Edition - Manual", generation: "991.1", year: 2013 + (i % 2) })),
  ])]);
  const comps = index.comparables("me");
  assert.equal(comps.exactCount, 5);
});

test("comparables() agrees on a trim that one lot names in its title and the other in the platform's taxonomy", () => {
  const index = new SoldIndex([fakeScraper(tmpDir(), "a", [
    car("me", { model: "911 50th Anniversary Edition", trimName: "50th Anniversary Edition", title: "2014 Porsche 911 (991) 50th Anniversary Edition", generation: "991.1", year: 2014 }),
    ...Array.from({ length: 5 }, (_, i) => car(`cc${i}`, { model: "911 (991) 50th Anniversary Edition", trimName: "Carrera S", title: "2013 Porsche 911 (991) 50th Anniversary Edition - Manual", generation: "991.1", year: 2013 })),
  ])]);
  assert.equal(index.comparables("me").exactCount, 5);
});

test("comparables() returns nothing to compare when the car has no model line", () => {
  const index = new SoldIndex([fakeScraper(tmpDir(), "a", [lot("x", { model: null })])]);
  const comps = index.comparables("x");
  assert.equal(comps.line, null);
  assert.deepEqual(comps.lots, []);
  assert.equal(index.comparables("nope"), null);
});

test("flags are derived from the title for lots whose archive has not computed them yet", () => {
  const index = new SoldIndex([fakeScraper(tmpDir(), "a", [
    lot("late", { title: "Modified 1996 Porsche 911 Carrera", flags: undefined }),
    lot("stored", { title: "Modified 1996 Porsche 911 Carrera", flags: ["special"] }),
  ])]);
  const byId = Object.fromEntries(index.points().rows.map(r => [r[0], r]));
  assert.equal(byId.late[17] & 1, 1);
  assert.equal(byId.stored[17] & 1, 0); // уже посчитанное архивом не пересчитываем
});

test("identity level says how sure we are which car this is, from identifiers only", () => {
  const dir = tmpDir();
  const V = "WP0CD2A94RS257786";
  const index = new SoldIndex([fakeScraper(dir, "a", [
    lot("multi1", { vin: V, vinDecoded: true, soldAt: "2022-03-01T00:00:00.000Z" }),
    lot("multi2", { vin: V, vinDecoded: true, soldAt: "2025-05-01T00:00:00.000Z", source: "RM Sotheby's" }),
    lot("rep1", { vin: "WP0CD2A94RS111111", soldAt: "2022-03-01T00:00:00.000Z" }),
    lot("rep2", { vin: "WP0CD2A94RS111111", soldAt: "2023-03-01T00:00:00.000Z" }),
    lot("dec", { vin: "WP0CD2A94RS222222", vinDecoded: true, vinCheck: [{ field: "displacement", lot: 3.2, vin: 3.6 }] }),
    lot("undec", { vin: "WP0CD2A94RS333333" }),
    lot("ch", { chassis: "164877D153201", make: "Chevrolet" }),
    lot("weak", { chassis: "A1" }),
    lot("none", {}),
    lot("conf", { vin: "WP0CD2A94RS444444", vinDecoded: true, vinMismatch: "Audi" }),
    lot("bad1", { vin: "WP0CD2A94RS555555", year: 1992 }),
    lot("bad2", { vin: "WP0CD2A94RS555555", year: 2015, soldAt: "2026-09-01T00:00:00.000Z" }),
  ])]);

  const level = id => index.identity(id).level;
  assert.equal(level("multi2"), "multi");
  assert.deepEqual(index.identity("multi1").sources.sort(), ["Bring a Trailer", "RM Sotheby's"]);
  assert.equal(index.identity("multi1").sales, 2);
  assert.equal(level("rep1"), "repeat");
  assert.equal(level("dec"), "decoded");
  assert.equal(index.identity("dec").checks, 1);
  assert.equal(level("undec"), "undecoded");
  assert.equal(level("ch"), "chassis");
  assert.equal(level("weak"), "weak");
  assert.equal(level("none"), "none");
  assert.equal(level("conf"), "conflict");
  assert.equal(level("bad1"), "inconsistent"); // один VIN, годы 1992 и 2015
  assert.equal(index.identity("nope"), null);
});

test("the same car sold again on the same platform within 45 days is a relist, not a resale; a quick flip to another platform still counts", () => {
  const dir = tmpDir();
  const index = new SoldIndex([fakeScraper(dir, "a", [
    lot("r1", { vin: "WP0CD2A94RS600001", soldAt: "2026-03-01T00:00:00.000Z", salePrice: 25000 }),
    lot("r2", { vin: "WP0CD2A94RS600001", soldAt: "2026-03-21T00:00:00.000Z", salePrice: 27000 }), // выкуп не состоялся, лот выставили снова
    lot("f1", { vin: "WP0CD2A94RS600002", soldAt: "2026-03-01T00:00:00.000Z", salePrice: 25000 }),
    lot("f2", { vin: "WP0CD2A94RS600002", soldAt: "2026-03-08T00:00:00.000Z", salePrice: 30000, source: "RM Sotheby's" }),
    lot("g1", { vin: "WP0CD2A94RS600003", soldAt: "2025-03-01T00:00:00.000Z" }),
    lot("g2", { vin: "WP0CD2A94RS600003", soldAt: "2026-03-01T00:00:00.000Z" }),
  ])]);
  assert.deepEqual(index.history("r2"), []); // осталась одна запись
  assert.deepEqual(index.history("f2").map(l => l.id), ["f1", "f2"]);
  assert.deepEqual(index.history("g2").map(l => l.id), ["g1", "g2"]);
});

test("signs, bicycles, motorcycles and boats stay out of the index, and lots without a year are not used as comparables", () => {
  const dir = tmpDir();
  const lots = [
    lot("car", { title: "1992 Porsche 911 Carrera", year: 1992 }),
    lot("sign", { title: "Neon Plymouth Road Runner Sign", make: "Neon", year: null }),
    lot("bike", { title: "Four Schwinn Sting-Ray Bicycles", make: "Four", year: null }),
    lot("moto", { title: "1999 Ducati 916", make: "Ducati", year: 1999 }),
    lot("noyear", { title: "Porsche 911 Replica", year: null }),
  ];
  const index = new SoldIndex([fakeScraper(dir, "a", lots)]);
  assert.deepEqual(index.points().rows.map(row => row[0]).sort(), ["car", "noyear"]);
  assert.equal(index.lot("sign"), null);
  assert.ok(!(index.comparables("car")?.lots || []).some(item => item.id === "noyear"));
});

test("points carry the sale region (country, or the currency when the country is unknown), and comparables keep other markets for the end with a label", () => {
  const dir = tmpDir();
  const lots = [
    lot("me", { vin: "WP0CD2A94RS700001", country: "US", salePrice: 100000 }),
    lot("us1", { country: "US", salePrice: 98000, soldAt: "2026-03-09T00:00:00.000Z" }),
    lot("uk1", { country: "GB", currency: "GBP", salePrice: 150000, soldAt: "2026-03-08T00:00:00.000Z" }),
    lot("eu1", { currency: "EUR", salePrice: 140000, soldAt: "2026-03-07T00:00:00.000Z" }), // страны нет — по валюте: Европа
    lot("nocur", { salePrice: 90000, soldAt: "2026-03-06T00:00:00.000Z" }), // ни страны, ни валюты — доллары, США по валюте
  ];
  const index = new SoldIndex([fakeScraper(dir, "a", lots)]);
  const { fields, dict, rows } = index.points();
  const regionOfRow = id => dict.region[rows.find(row => row[0] === id)[fields.indexOf("region")]];
  assert.equal(regionOfRow("us1"), "US");
  assert.equal(regionOfRow("uk1"), "GB");
  assert.equal(regionOfRow("eu1"), "EU");
  assert.equal(regionOfRow("nocur"), "US");

  const full = index.lotsByIds(["uk1", "eu1"]);
  assert.equal(full[0].region, "GB");
  assert.equal(full[0].regionBasis, "country");
  assert.equal(full[1].regionBasis, "currency");

  const comps = index.comparables("me");
  const byId = Object.fromEntries(comps.lots.map(item => [item.id, item]));
  assert.equal(byId.us1.similarity, "exact");
  assert.equal(byId.uk1.similarity, "near");
  assert.ok(byId.uk1.differs.includes("рынок: Великобритания"));
  assert.ok(byId.eu1.differs.includes("рынок: Европа"));
});
