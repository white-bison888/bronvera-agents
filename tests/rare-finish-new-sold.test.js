const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { finishNewSold, SOURCES } = require("../src/rare/finish-new-sold");
const { loadSoldArchive, saveSoldArchive } = require("../src/rare/sold-archive");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-finish-")), "sold.json");

/* NHTSA в тесте — подставной ответ: одна запись на каждый VIN, марка совпадает с лотом. */
const nhtsa = vins => async () => ({
  ok: true,
  json: async () => ({ Results: vins.map(vin => ({ VIN: vin, Make: "PORSCHE", Model: "911", ModelYear: "1992", ErrorCode: "0", PlantCountry: "GERMANY" })) }),
});

test("finishNewSold parses the pages of unchecked lots, decodes new VINs and fills the flags, and leaves done lots alone", async () => {
  const file = tmpFile();
  saveSoldArchive(file, {
    old: { id: "old", title: "1992 Porsche 911 Carrera", make: "Porsche", year: 1992, vin: "WP0ZZZ96ZNS490001", vinCheckedAt: "2026-01-01T00:00:00.000Z", pageCheckedAt: "2026-01-01T00:00:00.000Z" },
    fresh: { id: "fresh", title: "1992 Porsche 911 Carrera 4 Modified", make: "Porsche", year: 1992, vin: "WP0ZZZ96ZNS490002" },
  });
  const calls = [];
  const scraper = {
    soldFile: () => file,
    async enrichSoldFromPages(options) {
      calls.push(options);
      const archive = loadSoldArchive(file);
      archive.fresh.exteriorColor = "Guards Red";
      archive.fresh.pageCheckedAt = "2026-10-06T00:00:00.000Z";
      saveSoldArchive(file, archive);
      return { checked: 1, filled: 1 };
    },
  };

  const result = await finishNewSold("bat", { create: () => scraper, log: () => {}, vinOptions: { fetchImpl: nhtsa(["WP0ZZZ96ZNS490002"]), sleep: async () => {}, delayMs: 0 } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, SOURCES.bat.pages.limit);
  assert.deepEqual(result.pages, { checked: 1, filled: 1 });
  assert.equal(result.vin.checked, 1); // только новый VIN; у «old» отметка уже стоит
  const archive = loadSoldArchive(file);
  assert.equal(archive.fresh.exteriorColor, "Guards Red");
  assert.ok(archive.fresh.vinCheckedAt);
  assert.ok(archive.fresh.flags.includes("modified")); // особенность — по названию
  assert.equal(archive.old.vinDecoded, undefined);
});

test("a source without page parsing (Hemmings, Collecting Cars) only decodes VINs", async () => {
  const file = tmpFile();
  saveSoldArchive(file, { a: { id: "a", title: "1992 Porsche 911", make: "Porsche", year: 1992, vin: "WP0ZZZ96ZNS490003" } });
  const scraper = { soldFile: () => file, enrichSoldFromPages: async () => { throw new Error("страницы не должны разбираться"); } };
  const result = await finishNewSold("hemmings", { create: () => scraper, log: () => {}, vinOptions: { fetchImpl: nhtsa(["WP0ZZZ96ZNS490003"]), sleep: async () => {}, delayMs: 0 } });
  assert.equal(result.pages, null);
  assert.equal(result.vin.checked, 1);
});

test("an unknown source name is an error", async () => {
  await assert.rejects(() => finishNewSold("nope", { log: () => {} }), /неизвестный источник/);
});
