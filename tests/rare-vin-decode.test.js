const { test } = require("node:test");
const assert = require("node:assert/strict");

const { applyDecoded, enrichWithVinDecode, sameMake } = require("../src/rare/vin-decode");

const porsche = { Make: "PORSCHE", Model: "911", ModelYear: "2024", Trim: "Turbo Cabriolet, Turbo S Cabriolet", Series: "Type 992", BodyClass: "Convertible/Cabriolet", EngineCylinders: "6", DisplacementL: "3.7", Turbo: "Yes", EngineHP: "572", PlantCountry: "GERMANY", ErrorCode: "0" };

test("sameMake matches regardless of case, punctuation and extra words", () => {
  assert.ok(sameMake("Mercedes-Benz", "MERCEDES-BENZ"));
  assert.ok(sameMake("Chevrolet", "CHEVROLET"));
  assert.ok(sameMake("Land Rover", "LAND ROVER"));
  assert.ok(sameMake("Mercedes-Benz", "Mercedes-Benz Trucks"));
  assert.ok(!sameMake("Porsche", "Ferrari"));
  assert.ok(!sameMake("", "Ferrari"));
});

test("a clean decode overwrites a guessed engine and fills body, generation, trim, hp, plant", () => {
  const lot = { make: "Porsche", year: 2024, cylinders: 8, engineLayout: "V", displacement: 4.0, bodyStyle: null };
  const changed = applyDecoded(lot, porsche, Date.parse("2026-10-02T00:00:00Z"));

  assert.ok(changed > 0);
  assert.equal(lot.cylinders, 6);
  assert.equal(lot.displacement, 3.7);
  assert.equal(lot.bodyStyle, "Кабриолет");
  assert.equal(lot.aspiration, "Турбо");
  assert.equal(lot.generation, "992");
  assert.equal(lot.vinTrim, "Turbo Cabriolet, Turbo S Cabriolet");
  assert.equal(lot.hp, 572);
  assert.equal(lot.plantCountry, "GERMANY");
  assert.equal(lot.vinDecoded, true);
  assert.equal(lot.vinCheckedAt, "2026-10-02T00:00:00.000Z");
});

test("an unclean decode (wrong check digit) only fills what is missing, never overwrites", () => {
  const lot = { make: "Ferrari", cylinders: 8, bodyStyle: null };
  applyDecoded(lot, { Make: "FERRARI", Model: "California", BodyClass: "Convertible/Cabriolet", EngineCylinders: "12", ErrorCode: "1", PlantCountry: "ITALY" });
  assert.equal(lot.cylinders, 8);
  assert.equal(lot.bodyStyle, "Кабриолет");
  assert.equal(lot.plantCountry, "ITALY");
});

test("a VIN whose make disagrees with the lot is not trusted: nothing applied, lot marked as checked", () => {
  const lot = { make: "Ford", cylinders: 8 };
  assert.equal(applyDecoded(lot, porsche), 0);
  assert.equal(lot.cylinders, 8);
  assert.equal(lot.vinDecoded, false);
  assert.equal(lot.vinMismatch, "PORSCHE");
  assert.ok(lot.vinCheckedAt);
});

test("an unknown VIN is marked checked so it is not asked again", () => {
  const lot = { make: "Porsche" };
  applyDecoded(lot, undefined);
  assert.equal(lot.vinDecoded, false);
  assert.ok(lot.vinCheckedAt);
});

test("drive type, engine layout and body class mappings", () => {
  const lot = { make: "Chevrolet" };
  applyDecoded(lot, { Make: "CHEVROLET", ErrorCode: "0", DriveType: "4WD/4-Wheel Drive/4x4", EngineConfiguration: "V-Shaped", EngineCylinders: "8", DisplacementL: "5.7", BodyClass: "Pickup" });
  assert.equal(lot.drivetrain, "Полный");
  assert.equal(lot.engineLayout, "V");
  assert.equal(lot.bodyStyle, "Пикап");
});

test("enrichWithVinDecode sends batches of 50 VINs, skips lots already checked or without a VIN", async () => {
  const lots = Array.from({ length: 120 }, (_, i) => ({ id: `l${i}`, make: "Porsche", vin: `WP0CD2A94RS${String(i).padStart(6, "0")}` }));
  lots.push({ id: "noVin", make: "Porsche" }, { id: "done", make: "Porsche", vin: "WP0CD2A94RS999999", vinCheckedAt: "2026-01-01" });
  const bodies = [];
  let saves = 0;

  const result = await enrichWithVinDecode({
    lots,
    delayMs: 0,
    sleep: async () => {},
    save: () => { saves += 1; },
    fetchImpl: async (url, init) => {
      const data = new URLSearchParams(init.body).get("data").split(";");
      bodies.push(data.length);
      return { ok: true, status: 200, json: async () => ({ Results: data.map(vin => ({ ...porsche, VIN: vin })) }) };
    },
  });

  assert.deepEqual(bodies, [50, 50, 20]);
  assert.equal(result.checked, 120);
  assert.ok(lots.slice(0, 120).every(lot => lot.vinDecoded === true));
  assert.equal(lots.find(l => l.id === "noVin").vinCheckedAt, undefined);
  assert.ok(saves >= 1);
});

test("enrichWithVinDecode surfaces an NHTSA failure instead of marking lots as checked", async () => {
  const lots = [{ id: "a", make: "Porsche", vin: "WP0CD2A94RS257786" }];
  await assert.rejects(() => enrichWithVinDecode({ lots, delayMs: 0, sleep: async () => {}, save: () => {}, fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
  assert.equal(lots[0].vinCheckedAt, undefined);
});
