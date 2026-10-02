const { test } = require("node:test");
const assert = require("node:assert/strict");

const { bodyStyleOf, drivetrainOf, engineLabel, engineOf, parseVehicleAttributes, steeringOf } = require("../src/rare/sold-attrs");
const { buildFamilyResolver } = require("../src/rare/model-family");

test("bodyStyleOf reads the body from title or description, most specific word first", () => {
  assert.equal(bodyStyleOf("1987 Porsche 911 Targa"), "Тарга");
  assert.equal(bodyStyleOf("1999 Porsche 911 Carrera Cabriolet 6-Speed"), "Кабриолет");
  assert.equal(bodyStyleOf("1992 Mazda MX-5 Miata Roadster"), "Родстер");
  assert.equal(bodyStyleOf("2004 Mercedes-Benz E500 Wagon"), "Универсал");
  assert.equal(bodyStyleOf("2018 Ford F-150 SuperCrew 4×4"), "Пикап");
  assert.equal(bodyStyleOf("1994 BMW M3 Coupe"), "Купе");
  assert.equal(bodyStyleOf("1994 BMW M3 Sedan"), "Седан");
  assert.equal(bodyStyleOf("1985 Ferrari 308 GTS", "A Grand Touring car."), null);
  assert.equal(bodyStyleOf(""), null);
});

test("engineOf reads layout, cylinders, displacement and aspiration from BaT-style text", () => {
  assert.deepEqual(engineOf("powered by a twin-turbocharged 3.6-liter flat-six"), { cylinders: 6, engineLayout: "Оппозитный", displacement: 3.6, aspiration: "Турбо" });
  assert.deepEqual(engineOf("a supercharged 6.2-liter Hemi V8"), { cylinders: 8, engineLayout: "V", displacement: 6.2, aspiration: "Компрессор" });
  assert.deepEqual(engineOf("a 2.4-liter 22R inline-four"), { cylinders: 4, engineLayout: "Рядный", displacement: 2.4, aspiration: null });
  assert.deepEqual(engineOf("3.8L Twin-Turbocharged H6"), { cylinders: 6, engineLayout: "Оппозитный", displacement: 3.8, aspiration: "Турбо" });
  assert.deepEqual(engineOf("a 350ci V8"), { cylinders: 8, engineLayout: "V", displacement: 5.7, aspiration: null });
  assert.deepEqual(engineOf("a twin-rotor rotary engine").engineLayout, "Роторный");
  assert.deepEqual(engineOf(""), { cylinders: null, engineLayout: null, displacement: null, aspiration: null });
});

test("engineLabel makes a short filter label", () => {
  assert.equal(engineLabel({ cylinders: 8, engineLayout: "V" }), "V8");
  assert.equal(engineLabel({ cylinders: 6, engineLayout: "Оппозитный" }), "Оппозитный 6");
  assert.equal(engineLabel({ cylinders: 4, engineLayout: "Рядный" }), "Рядный 4");
  assert.equal(engineLabel({ cylinders: null, engineLayout: "Роторный" }), "Роторный");
  assert.equal(engineLabel({ cylinders: null, engineLayout: null }), null);
  assert.equal(engineLabel({ cylinders: 6, engineLayout: null }), "6 цил."); // расположение неизвестно — не «рядный»
});

test("drivetrainOf and steeringOf only report what the text states", () => {
  assert.equal(drivetrainOf("with all-wheel drive"), "Полный");
  assert.equal(drivetrainOf("2018 Ford F-150 4×4"), "Полный");
  assert.equal(drivetrainOf("RWD-Converted 1997 Porsche 911 Turbo"), "Задний");
  assert.equal(drivetrainOf("front-wheel-drive layout"), "Передний");
  assert.equal(drivetrainOf("a nice car"), null);
  assert.equal(steeringOf("a left-hand-drive Sport 300"), "Левый");
  assert.equal(steeringOf("Japanese-Market RHD 2015 Volvo"), "Правый");
  assert.equal(steeringOf("plain"), null);
});

test("parseVehicleAttributes drops everything it could not find", () => {
  const found = parseVehicleAttributes("1997 Porsche 911 Turbo Coupe", "twin-turbocharged 3.6-liter flat-six, rear-wheel drive");
  assert.deepEqual(found, { bodyStyle: "Купе", cylinders: 6, engineLayout: "Оппозитный", displacement: 3.6, aspiration: "Турбо", drivetrain: "Задний" });
  assert.deepEqual(parseVehicleAttributes("350-Powered Replica"), {});
});

const lots = (make, models) => models.flatMap(([model, n]) => Array.from({ length: n }, () => ({ make, model })));

test("buildFamilyResolver keeps a broad line together and splits off the trim", () => {
  const resolve = buildFamilyResolver([
    ...lots("Porsche", [["911 Turbo", 10], ["911 Carrera", 12], ["911 Carrera S", 8], ["911 GT3", 6], ["Cayman", 5]]),
    ...lots("Jeep", [["Grand Cherokee Trackhawk", 6], ["Grand Cherokee Laredo", 5], ["Wrangler Rubicon", 5], ["Wrangler Sahara", 4], ["Wrangler Sport", 3]]),
  ]);

  assert.deepEqual(resolve({ make: "Porsche", model: "911 Turbo" }), { family: "911", trim: "Turbo", generation: null });
  assert.deepEqual(resolve({ make: "Porsche", model: "911 Carrera S" }), { family: "911", trim: "Carrera S", generation: null });
  assert.deepEqual(resolve({ make: "Porsche", model: "Cayman" }), { family: "Cayman", trim: null, generation: null });
  assert.deepEqual(resolve({ make: "Jeep", model: "Grand Cherokee Trackhawk" }), { family: "Grand Cherokee", trim: "Trackhawk", generation: null });
  assert.deepEqual(resolve({ make: "Jeep", model: "Wrangler Rubicon" }), { family: "Wrangler", trim: "Rubicon", generation: null });
  assert.deepEqual(resolve({ make: "Jeep", model: null }), { family: null, trim: null, generation: null });
});

test("buildFamilyResolver always joins «Model»/«Series»-style first words with the next one", () => {
  const resolve = buildFamilyResolver(lots("Ford", [["Model T", 2], ["Model A Tudor", 1]]));
  assert.deepEqual(resolve({ make: "Ford", model: "Model T" }), { family: "Model T", trim: null, generation: null });
  assert.deepEqual(resolve({ make: "Ford", model: "Model A Tudor" }), { family: "Model A", trim: "Tudor", generation: null });
});

test("buildFamilyResolver moves a parenthesised chassis code into generation and trims stray dashes", () => {
  const resolve = buildFamilyResolver(lots("Porsche", [["911 (997) Turbo -", 6], ["911 (997) Carrera S", 6], ["911 (964) Carrera 2", 6], ["911 Speedster", 5]]));
  assert.deepEqual(resolve({ make: "Porsche", model: "911 (997) Turbo -" }), { family: "911", trim: "Turbo", generation: "997" });
  assert.deepEqual(resolve({ make: "Porsche", model: "911 (964) Carrera 2" }), { family: "911", trim: "Carrera 2", generation: "964" });
  assert.deepEqual(resolve({ make: "Porsche", model: "911 Speedster" }), { family: "911", trim: "Speedster", generation: null });
});

test("engineOf understands Collecting Cars powertrain strings: «5.5L 8V», «3.2L VR6», «0.6L H2»", () => {
  assert.equal(engineOf("5.5L 8V (M113)").cylinders, 8);
  assert.equal(engineOf("5.5L 8V (M113)").engineLayout, "V");
  assert.equal(engineOf("3.2L VR6").cylinders, 6);
  assert.equal(engineOf("0.6L H2").engineLayout, "Оппозитный");
  assert.equal(engineOf("0.6L H2").cylinders, 2);
  assert.equal(engineOf("Dual Electric Motor").cylinders, null);
});

test("«Turbo-Look» is a body package, not a turbocharged engine", () => {
  assert.equal(engineOf("1989 Porsche 911 Carrera 3.2 Targa 'Turbo-Look'").aspiration, null);
  assert.equal(engineOf("1986 Porsche 911 Carrera 3.2 Turbo Look").aspiration, null);
  assert.equal(engineOf("1989 Porsche 911 Turbo").aspiration, "Турбо");
  assert.equal(engineOf("Turbo-Look body with a turbocharged 3.3-liter flat-six").aspiration, "Турбо");
});
