const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadSoldArchive, readSoldArchiveCached, saveSoldArchive } = require("../src/rare/sold-archive");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-sold-archive-")), "sold.json");

test("нет файла — пустой архив, это первый запуск", () => {
  assert.deepEqual(loadSoldArchive(tmpFile()), {});
});

test("обрезанный файл — ошибка, а не пустой архив", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{\"bat-1\":{\"id\":\"bat-1\",\"salePr");

  assert.throws(() => loadSoldArchive(file), /повреждён/);
  assert.equal(fs.readFileSync(file, "utf8").startsWith("{\"bat-1\""), true);
});

test("запись идёт через временный файл и не оставляет его после себя", () => {
  const file = tmpFile();
  saveSoldArchive(file, { a: { id: "a" } });

  assert.deepEqual(loadSoldArchive(file), { a: { id: "a" } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["sold.json"]);
});

test("большой архив нельзя заменить маленьким без явного разрешения", () => {
  const file = tmpFile();
  const big = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`bat-${i}`, { id: `bat-${i}`, title: "x".repeat(60) }]));
  saveSoldArchive(file, big);
  const size = fs.statSync(file).size;

  assert.throws(() => saveSoldArchive(file, { one: { id: "one" } }), /уменьшился бы/);
  assert.equal(fs.statSync(file).size, size);

  saveSoldArchive(file, { one: { id: "one" } }, { allowShrink: true });
  assert.deepEqual(loadSoldArchive(file), { one: { id: "one" } });
});

test("чтение для сайта не падает на повреждённом файле и не трогает его", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{\"broken\":");

  assert.deepEqual(readSoldArchiveCached(file), {});
  assert.equal(fs.readFileSync(file, "utf8"), "{\"broken\":");
});
