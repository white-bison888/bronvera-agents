const { test } = require("node:test");
const assert = require("node:assert/strict");

const { colorGroupOf, parseBatExcerpt, parseMileageText, transmissionKind } = require("../src/rare/sold-fields");

test("parseMileageText reads miles and kilometres (converted to miles), with thousands separators and k", () => {
  assert.equal(parseMileageText("64,500 Miles"), 64500);
  assert.equal(parseMileageText("17,067 Miles"), 17067);
  assert.equal(parseMileageText("25,660 Km "), 15944);
  assert.equal(parseMileageText("12k miles"), 12000);
  assert.equal(parseMileageText("no odometer"), null);
  assert.equal(parseMileageText(null), null);
});

test("transmissionKind separates manual from automatic (dual-clutch and robots count as automatic)", () => {
  assert.equal(transmissionKind("5-Speed Manual"), "manual");
  assert.equal(transmissionKind("six-speed manual transmission"), "manual");
  assert.equal(transmissionKind("6-ступенчатая механика"), "manual");
  assert.equal(transmissionKind("eight-speed automatic transmission"), "automatic");
  assert.equal(transmissionKind("seven-speed dual-clutch"), "automatic");
  assert.equal(transmissionKind("PDK"), "automatic");
  assert.equal(transmissionKind("3-ступенчатый автомат"), "automatic");
  assert.equal(transmissionKind("five-speed"), null);
  assert.equal(transmissionKind(null), null);
});

test("colorGroupOf maps paint names to base colours and says «Другой» for the unknown", () => {
  assert.equal(colorGroupOf("Guards Red"), "Красный");
  assert.equal(colorGroupOf("Bright Aqua Metallic"), "Синий");
  assert.equal(colorGroupOf("British Racing Green"), "Зелёный");
  assert.equal(colorGroupOf("Silver Grey"), "Серебристый");
  assert.equal(colorGroupOf("Jet Black"), "Чёрный");
  assert.equal(colorGroupOf("Alpine White"), "Белый");
  assert.equal(colorGroupOf("Xirallic Mystery"), "Другой");
  assert.equal(colorGroupOf(""), null);
  assert.equal(colorGroupOf(null), null);
});

test("parseBatExcerpt takes colour, mileage and transmission from BaT's standard description", () => {
  const found = parseBatExcerpt(
    "1993 Chevrolet Corvette ZR-1",
    "This 1993 Chevrolet Corvette ZR-1 is finished in Bright Aqua Metallic over Light Gray leather. It has 24k miles and a ZF six-speed manual transmission.",
  );
  assert.equal(found.exteriorColor, "Bright Aqua Metallic");
  assert.equal(found.mileage, 24000);
  assert.match(found.transmissionRaw, /six-speed manual transmission/i);
});

test("parseBatExcerpt prefers the mileage in the title, decodes HTML entities and handles «refinished in red over tan»", () => {
  const found = parseBatExcerpt(
    "4,200-Mile 2005 Aston Martin DB9 Volante",
    "This 2005 Aston Martin DB9 Volante has 99,000 miles and was refinished in red over tan and brown vinyl. Owner&#039;s manual included.",
  );
  assert.equal(found.mileage, 4200);
  assert.equal(found.exteriorColor, "red");
});

test("parseBatExcerpt reads the «white-over-beige» shorthand and returns nulls when nothing is stated", () => {
  assert.equal(parseBatExcerpt("2014 Bentley Flying Spur", "This 2014 Bentley Flying Spur is a white-over-beige car with 45k miles.").exteriorColor, "white");
  const nothing = parseBatExcerpt("1984 Chevrolet Corvette", "A clean example with a long history.");
  assert.deepEqual(nothing, { exteriorColor: null, mileage: null, transmissionRaw: null });
});

test("colour words need word boundaries: «numbers» is not umber, «thousand» is not sand", () => {
  assert.equal(colorGroupOf("numbers greater than"), "Другой");
  assert.equal(colorGroupOf("thousand"), "Другой");
  assert.equal(colorGroupOf("Burnt Orange"), "Оранжевый");
  assert.equal(colorGroupOf("Azzurro California"), "Синий");
});

test("cleanColor strips flattering adjectives and filler nouns from a captured paint phrase", () => {
  const { cleanColor } = require("../src/rare/sold-fields");
  assert.equal(cleanColor("harmonious Dove Blue"), "Dove Blue");
  assert.equal(cleanColor("red exterior and"), "red");
  assert.equal(cleanColor("livery of blue"), "blue");
  assert.equal(cleanColor("beautiful"), null);
});

test("parseRmText takes colour, mileage in miles or kilometres and the gearbox from an RM essay", () => {
  const { parseRmText } = require("../src/rare/sold-fields");
  const found = parseRmText("The car is finished in Rosso Corsa over a Nero interior. The odometer shows 12,345 kilometres. A five-speed manual gearbox is fitted.");
  assert.equal(found.exteriorColor, "Rosso Corsa");
  assert.equal(found.mileage, 7671);
  assert.match(found.transmissionRaw, /five-speed manual gearbox/i);
  const loose = parseRmText("Resplendent in Azzurro with a tan leather interior, it retains its numbers-matching engine.");
  assert.equal(loose.exteriorColor, "Azzurro");
  assert.equal(parseRmText("A fine car.").exteriorColor, null);
});
