const { test } = require("node:test");
const assert = require("node:assert/strict");

const { guessMake, guessModel } = require("../src/rare/title-parser");
const { yearFromTitle } = require("../src/rare/sold-archive");

const make = title => guessMake(title);

test("a paint colour in front of the make does not become the make", () => {
  assert.equal(make("2021 Oslo Blue Porsche 911 Targa 4S"), "Porsche");
  assert.equal(guessModel("2021 Oslo Blue Porsche 911 Targa 4S", "Porsche"), "911");
});

test("descriptors like «383-Powered», «27-Years-Owned,» and apostrophe years are skipped to reach the make", () => {
  assert.equal(make("383-Powered '32 Ford Roadster"), "Ford");
  assert.equal(make("27-Years-Owned, 460-Powered '33 Ford Pickup"), "Ford");
  assert.equal(make("Two-Decades-Owned, Fuel-Injected 454-Powered '41 Willys Coupe"), "Willys");
  assert.equal(make("Hilborn Fuel-Injected, 350-Powered Ford Highboy Roadster"), "Ford");
});

test("multi-word makes and spelling variants are kept together", () => {
  assert.equal(make("2022 Can AM Defender Pro"), "Can-Am");
  assert.equal(make("2022 Can-Am Defender Pro"), "Can-Am");
  assert.equal(make("460-Powered Factory Five Racing Mk2 Roadster 5-Speed"), "Factory Five Racing");
  assert.equal(make("2024 The Little Car Company Bugatti Baby II Vitesse"), "The Little Car Company");
  assert.equal(make("2018 AM General Humvee"), "AM General");
  assert.equal(make("1995 Citroen 2CV"), "Citroën");
  assert.equal(make("1960 Austin Healey 3000"), "Austin-Healey");
});

test("an ordinary title and a rare make are parsed as before", () => {
  assert.equal(make("1965 Ford Mustang Shelby GT350"), "Ford");
  assert.equal(guessModel("1965 Ford Mustang Shelby GT350", "Ford"), "Mustang Shelby GT350");
  assert.equal(make("1960 Hillman Husky Series I Project"), "Hillman");
  assert.equal(make("1971 Meyers Manx Dune Buggy"), "Meyers"); // редкая марка перед моделью — остаётся как есть
  assert.equal(make("Modified 1996 Porsche 911 Carrera"), "Porsche");
  assert.equal(guessModel("1985 BMW 325e Coupe 5-Speed", "BMW"), "325e");
});

test("a make given separately (Collecting Cars) still decides where the model starts", () => {
  assert.equal(guessModel("2019 Aston Martin DB11 Volante", "Aston Martin"), "DB11 Volante");
});

test("a two-digit apostrophe year in a title is read as 19xx when there is no four-digit year", () => {
  assert.equal(yearFromTitle("383-Powered '32 Ford Roadster"), 1932);
  assert.equal(yearFromTitle("1965 Ford Mustang"), 1965);
  assert.equal(yearFromTitle("No year here"), null);
});

test("a bare number in a title is a model, not a descriptor, so a later well-known make does not steal the title", () => {
  assert.equal(make("1939 SS 100 Jaguar 3½-Litre Roadster"), "SS");
  assert.equal(make("2010 Abarth 695 Tributo Ferrari"), "Abarth");
  assert.equal(make("1964.5 Ford Mustang Convertible"), "Ford"); // «.5» — полугодовой модельный год, а не марка
});
