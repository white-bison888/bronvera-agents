const { test } = require("node:test");
const assert = require("node:assert/strict");

const { makeResolver, canonicalizeLot, norm } = require("../src/rare/model-directory");

const resolve = makeResolver();
const lot = (make, model, year, extra = {}) => ({ make, model, year, title: `${year} ${make} ${model}`, ...extra });

test("one family gets one name whatever the platform wrote: 380SL, 450SL and 560 SL are all the SL", () => {
  for (const model of ["380SL", "450SL", "560 SL", "SL500", "300 SL Roadster"]) {
    const found = resolve(lot("Mercedes-Benz", model, 1985));
    assert.equal(found.family, "SL", model);
    assert.equal(found.listed, true);
  }
});

test("the generation comes from the code in the title first, then from the years", () => {
  assert.equal(resolve(lot("Porsche", "911 Carrera", 2007)).generation, "997.1");
  assert.equal(resolve(lot("Porsche", "911 Carrera S (997.2)", 2009)).generation, "997.2");
  assert.equal(resolve(lot("Porsche", "911 (996.2) Carrera", 2003)).generation, "996.2");
  assert.equal(resolve(lot("Porsche", "911 Turbo", 1987)).generation, "G-серия (1974–1989)");
  assert.equal(resolve(lot("Porsche", "911 (930) Turbo", 1980)).generation, "G-серия (1974–1989)");
  assert.equal(resolve(lot("Chevrolet", "Corvette Stingray", 1969)).generation, "C3");
  assert.equal(resolve(lot("Chevrolet", "Corvette Z06", 2021)).generation, "C8");
  assert.equal(resolve(lot("BMW", "M3", 1990)).generation, "E30");
  assert.equal(resolve(lot("BMW", "(E46) M3", 2003)).generation, "E46");
});

test("the 190 SL and the 300 SL are separate generations of the SL when they overlap in years", () => {
  assert.equal(resolve(lot("Mercedes-Benz", "190 SL", 1960)).generation, "W121 (190 SL, 1955–1963)");
  assert.equal(resolve(lot("Mercedes-Benz", "300 SL Roadster", 1960)).generation, "W198 (300 SL, 1954–1963)");
  assert.equal(resolve(lot("Mercedes-Benz", "300 SL", 1991)).generation, "R129 (1989–2001)");
});

test("the trim is what remains of the model after the family and the generation code", () => {
  assert.equal(resolve(lot("Porsche", "911 Carrera 4S Cabriolet", 2013)).trim, "Carrera 4S Cabriolet");
  assert.equal(resolve(lot("Porsche", "911 (997.2) GT3 RS", 2010)).trim, "GT3 RS");
  assert.equal(resolve(lot("BMW", "(E46) M3", 2003)).trim, null);
});

test("a make written in capitals or an alias is the same make; the Range Rover as a make is moved to Land Rover", () => {
  assert.equal(resolve(lot("PORSCHE", "911", 1990)).family, "911");
  assert.equal(resolve(lot("FERRARI", "308 GTS", 1980)).family, "308");
  const moved = canonicalizeLot(lot("Range Rover", "Sport", 2008));
  assert.equal(moved.make, "Land Rover");
  assert.equal(moved.model, "Range Rover Sport");
  assert.equal(resolve(moved).family, "Range Rover");
  assert.equal(resolve(moved).make, "Land Rover");
});

test("a car outside the directory is marked as not listed, so the automatic split can take over", () => {
  const found = resolve(lot("Packard", "Twelve Sport Phaeton", 1934));
  assert.equal(found.listed, false);
  assert.equal(found.family, null);
  assert.equal(resolve(lot("Porsche", "Zzz Unknown", 2000)).listed, false);
});

test("the Mustang Mach-E is not the Mustang, and the Bronco Sport is not the Bronco", () => {
  assert.equal(resolve(lot("Ford", "Mustang Mach-E GT", 2022)).family, "Mustang Mach-E");
  assert.equal(resolve(lot("Ford", "Bronco Sport", 2022)).family, null);
  assert.equal(resolve(lot("Ford", "Bronco", 1972)).generation, "1-е (1966–1977)");
});

test("an administrator's addition goes first and can add a model the directory does not know", () => {
  const withExtra = makeResolver([{ make: "Packard", families: [{ name: "Twelve", match: "\\btwelve\\b", gens: [{ id: "1933–1934", from: 1933, to: 1934 }] }] }]);
  const found = withExtra(lot("Packard", "Twelve Sport Phaeton", 1934));
  assert.equal(found.family, "Twelve");
  assert.equal(found.generation, "1933–1934");
  assert.equal(norm("560 SL — «Pagoda»"), "560 sl - pagoda");
});
