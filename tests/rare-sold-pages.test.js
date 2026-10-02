const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { applyPatch, enrichFromPages } = require("../src/rare/sold-pages");
const BatScraper = require("../src/rare/bat-scraper");
const RmSothebysScraper = require("../src/rare/rmsothebys-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-sold-pages-"));

test("applyPatch fills only empty fields and never overwrites what is known", () => {
  const lot = { mileage: 100, exteriorColor: null, conditionFacts: [] };
  const changed = applyPatch(lot, { mileage: 999, exteriorColor: "Red", conditionFacts: ["Sunroof"], transmission: null, bodyStyle: "Купе" });
  assert.equal(changed, 3);
  assert.deepEqual(lot, { mileage: 100, exteriorColor: "Red", conditionFacts: ["Sunroof"], bodyStyle: "Купе" });
});

test("enrichFromPages visits each lot once, marks it, and a 404 page is marked without retrying", async () => {
  const lots = [{ id: "a", sourceUrl: "u/a" }, { id: "b", sourceUrl: "u/b" }, { id: "done", sourceUrl: "u/done", pageCheckedAt: "2026-01-01" }];
  const fetched = [];
  let saves = 0;

  const result = await enrichFromPages({
    lots,
    delayMs: 0,
    sleep: async () => {},
    save: () => { saves += 1; },
    fetchHtml: async (lot) => { fetched.push(lot.id); return lot.id === "b" ? null : "<html>ok</html>"; },
    parse: () => ({ mileage: 5000 }),
  });

  assert.deepEqual(fetched, ["a", "b"]);
  assert.equal(result.checked, 2);
  assert.equal(lots[0].mileage, 5000);
  assert.ok(lots[0].pageCheckedAt);
  assert.ok(lots[1].pageCheckedAt); // 404 — отмечен, второй раз не пойдём
  assert.equal(lots[1].mileage, undefined);
  assert.ok(saves >= 1);
});

test("enrichFromPages stops with an error after five failures in a row, keeping what was done", async () => {
  const lots = Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, sourceUrl: `u/${i}` }));
  let saved = 0;

  await assert.rejects(() => enrichFromPages({
    lots,
    delayMs: 0,
    sleep: async () => {},
    log: () => {},
    save: () => { saved += 1; },
    fetchHtml: async () => { throw new Error("страница ответила 429"); },
    parse: () => ({}),
  }), /слишком много подряд сбоев/);

  assert.ok(lots.every(lot => !lot.pageCheckedAt)); // сбойные лоты не отмечаем — повторим в следующий раз
});

const batPage = items => `<html><body><strong>Listing Details</strong><ul>${items.map(i => `<li>${i}</li>`).join("")}</ul></body></html>`;

test("BaT sold page: mileage, paint, interior, engine, drivetrain and equipment come from Listing Details", () => {
  const found = BatScraper.parseSoldPage(batPage([
    "Chassis: WP0CD2A94RS257786",
    "4,900 Miles",
    "Twin-Turbocharged 3.7-Liter Flat-Six",
    "Eight-Speed PDK Dual-Clutch Automatic Transaxle",
    "All-Wheel-Drive System",
    "Guards Red Paint",
    "Cognac Leather Upholstery",
    "Burmester Sound System",
  ]), { title: "2024 Porsche 911 Turbo S Cabriolet" });

  assert.equal(found.mileage, 4900);
  assert.equal(found.exteriorColor, "Guards Red");
  assert.equal(found.colorGroup, "Красный");
  assert.equal(found.interiorColor, "Cognac Leather Upholstery");
  assert.equal(found.transmissionKind, "automatic");
  assert.equal(found.cylinders, 6);
  assert.equal(found.engineLayout, "Оппозитный");
  assert.equal(found.displacement, 3.7);
  assert.equal(found.drivetrain, "Полный");
  assert.equal(found.bodyStyle, "Кабриолет");
  assert.ok(found.conditionFacts.includes("Burmester Sound System"));
  assert.ok(!found.conditionFacts.some(fact => /Chassis|4,900/.test(fact)));
  assert.deepEqual(BatScraper.parseSoldPage("<html>nothing</html>", {}), {});
});

test("BaT enrichSoldFromPages fills the archive from lot pages, most expensive first, once per lot", async () => {
  const dataDir = tmpDir();
  const fetched = [];
  const scraper = new BatScraper({
    dataDir,
    sleep: async () => {},
    log: () => {},
    fetchImpl: async (url) => { fetched.push(url); return { ok: true, status: 200, text: async () => batPage(["12,000 Miles", "Black Paint"]) }; },
  });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(scraper.soldFile(), JSON.stringify({
    cheap: { id: "cheap", title: "1990 Mazda Miata", sourceUrl: "https://bat/cheap", salePrice: 8000 },
    pricey: { id: "pricey", title: "1990 Ferrari F40", sourceUrl: "https://bat/pricey", salePrice: 1000000 },
  }));

  await scraper.enrichSoldFromPages({ delayMs: 0 });
  assert.deepEqual(fetched, ["https://bat/pricey", "https://bat/cheap"]);

  const byId = Object.fromEntries(scraper.readSold().map(l => [l.id, l]));
  assert.equal(byId.pricey.mileage, 12000);
  assert.equal(byId.pricey.exteriorColor, "Black");
  assert.ok(byId.pricey.pageCheckedAt);

  await scraper.enrichSoldFromPages({ delayMs: 0 });
  assert.equal(fetched.length, 2); // повторно не ходим

  fs.rmSync(dataDir, { recursive: true, force: true });
});

const rmPage = ({ bullets = [], essay = "", related = "" } = {}) => `<html><body>
  <nav>Menu Cabriolet Spyder</nav>
  <ul class="list-bullets ff-adapt">${bullets.map(b => `<li>${b}</li>`).join("")}</ul>
  <section class="container container--vw lotdescription"><div class="body-text--copy"><p>${essay}</p></div></section>
  <h3>You may also like:</h3><p>${related}</p>
</body></html>`;

test("RM lot page: colour, mileage, gearbox and engine from the lot's own text, ignoring «You may also like»", () => {
  const found = RmSothebysScraper.parseRmLotPage(rmPage({
    bullets: ["Finished in Rosso Corsa over a Nero interior"],
    essay: "The odometer shows 31,000 miles. Powered by a 4.7-litre V-12 with a five-speed manual gearbox.",
    related: "A 1960 Mercedes Spyder finished in Silver with an automatic gearbox.",
  }), { title: "1965 Ferrari 275 GTB" });

  assert.equal(found.exteriorColor, "Rosso Corsa");
  assert.equal(found.colorGroup, "Красный");
  assert.equal(found.mileage, 31000);
  assert.equal(found.transmissionKind, "manual");
  assert.equal(found.cylinders, 12);
  assert.equal(found.bodyStyle, undefined); // «Spyder» — из чужого блока, в названии кузова нет
});

test("RM lot page body style comes from the title only", () => {
  const found = RmSothebysScraper.parseRmLotPage(rmPage({ essay: "A superb roadster." }), { title: "1954 Jaguar XK 120 Roadster" });
  assert.equal(found.bodyStyle, "Родстер");
});
