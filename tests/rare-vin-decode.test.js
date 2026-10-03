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

test("a decode records which fields came from the VIN, what the VIN says about the car, and where it disagrees with the lot", () => {
  const lot = { make: "Porsche", year: 2021, cylinders: 8, displacement: 4.0, engineLayout: "V" };
  applyDecoded(lot, porsche);

  assert.ok(lot.vinFields.includes("cylinders"));
  assert.ok(lot.vinFields.includes("displacement"));
  assert.ok(lot.vinFields.includes("bodyStyle"));
  assert.ok(lot.vinFields.includes("hp"));
  assert.ok(!lot.vinFields.includes("year")); // год не перезаписываем — он есть в названии; расхождение — в vinCheck
  assert.equal(lot.vinInfo.model, "911");
  assert.equal(lot.vinInfo.year, 2024);
  assert.equal(lot.vinInfo.clean, true);
  assert.deepEqual(lot.vinCheck, [
    { field: "year", lot: 2021, vin: 2024 },
    { field: "displacement", lot: 4, vin: 3.7 },
    { field: "cylinders", lot: 8, vin: 6 },
  ]);
});

test("a repeated decode recomputes provenance from scratch; force re-checks lots that were already checked", async () => {
  const lot = { id: "x", make: "Porsche", vin: "WP0CD2A94RS257786", vinCheckedAt: "2026-01-01", vinFields: ["stale"], vinCheck: [{ field: "year", lot: 1, vin: 2 }] };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ Results: [{ ...porsche, VIN: lot.vin }] }) }; };

  await enrichWithVinDecode({ lots: [lot], delayMs: 0, sleep: async () => {}, save: () => {}, fetchImpl });
  assert.equal(calls, 0); // уже проверен

  await enrichWithVinDecode({ lots: [lot], delayMs: 0, sleep: async () => {}, save: () => {}, fetchImpl, force: true });
  assert.equal(calls, 1);
  assert.ok(!lot.vinFields.includes("stale"));
  assert.equal(lot.vinCheck, undefined);
});

test("a one-year difference between the VIN model year and the lot year is normal and is not reported", () => {
  const lot = { make: "Porsche", year: 2023 };
  applyDecoded(lot, porsche);
  assert.equal(lot.vinCheck, undefined);
});

test("an old Land Rover VIN that decodes 26 years late is the same year-code ambiguity, not a discrepancy", () => {
  const lot = { make: "Land Rover", year: 1989 };
  applyDecoded(lot, { Make: "LAND ROVER", ModelYear: "2015", ErrorCode: "0" });
  assert.equal(lot.vinCheck, undefined);
});

test("a 30-year gap is the VIN year code repeating (1993 vs 2023), not a real discrepancy", () => {
  const lot = { make: "Bugatti", year: 1993 };
  applyDecoded(lot, { Make: "BUGATTI", Model: "EB110", ModelYear: "2023", ErrorCode: "0" });
  assert.equal(lot.vinCheck, undefined);
  const real = { make: "Bugatti", year: 2014 };
  applyDecoded(real, { Make: "BUGATTI", Model: "Veyron", ModelYear: "2004", ErrorCode: "0" });
  assert.deepEqual(real.vinCheck, [{ field: "year", lot: 2014, vin: 2004 }]);
});

test("«по VIN» is claimed only for values that actually came from the VIN, not for ones the lot already had from its title", () => {
  const lot = { make: "Porsche", year: 1989, bodyStyle: "Тарга" }; // в названии «Targa»
  applyDecoded(lot, { Make: "PORSCHE", Model: "911", ModelYear: "1989", BodyClass: "Convertible/Cabriolet", EngineCylinders: "6", DisplacementL: "3.2", ErrorCode: "2,14" });
  assert.equal(lot.bodyStyle, "Тарга"); // название точнее грубого класса кузова из VIN
  assert.ok(!lot.vinFields.includes("bodyStyle"));
  assert.ok(lot.vinFields.includes("cylinders")); // эти поля были пустыми и заполнены из VIN
  assert.ok(lot.vinFields.includes("displacement"));
});
