const path = require("path");
const { spawn } = require("child_process");
const { loadSoldArchive, saveSoldArchive } = require("./sold-archive");
const { enrichWithVinDecode } = require("./vin-decode");
const { fillAttributes } = require("./sold-attrs");

/*
 * Доработка новых проданных лотов (06.10.2026). Суточный заход только добавляет лоты из списков; цвет, пробег, коробка,
 * номер шасси/VIN и особенности лежат на страницах самих лотов, а расшифровка VIN — в базе NHTSA. Раньше это делали
 * разовые скрипты руками, и новые лоты оставались «пустыми». Теперь после суточного захода источника запускается этот шаг:
 *   1) разбор страниц лотов, у которых нет отметки pageCheckedAt (не больше pageLimit за заход — остаток уйдёт в следующий);
 *   2) расшифровка VIN у лотов, где её ещё не было;
 *   3) особенности по названию там, где они не заполнены.
 * Работает в отдельном процессе: разбор страниц и большой архив BaT тянут память, а сервис живёт рядом с Dify на 3,8 ГБ.
 */

const SOURCES = {
  bat: { modulePath: "./bat-scraper", pages: { minPrice: 0, soldOnly: false, concurrency: 2, delayMs: 500, limit: 600 } },
  "rm-sothebys": { modulePath: "./rmsothebys-scraper", pages: { concurrency: 2, delayMs: 400, limit: 300 } },
  gooding: { modulePath: "./gooding-scraper", pages: { concurrency: 2, delayMs: 400, limit: 300 } },
  hemmings: { modulePath: "./hemmings-scraper", pages: null }, // у Hemmings список уже отдаёт VIN; страниц разбирать нечего
  "collecting-cars": { modulePath: "./collectingcars-scraper", pages: null }, // данные приходят из поискового индекса
};

const finishNewSold = async (key, { log = console.log, create = null, vinOptions = {}, pageOptions = null } = {}) => {
  const source = SOURCES[key];
  if (!source)
    throw new Error(`неизвестный источник: ${key}`);

  const scraper = create ? create() : new (require(source.modulePath))({ log });
  const result = { key, pages: null, vin: null, flags: 0 };

  const pages = pageOptions || source.pages;
  if (pages && typeof scraper.enrichSoldFromPages === "function")
    result.pages = await scraper.enrichSoldFromPages(pages);

  const file = scraper.soldFile();
  const archive = loadSoldArchive(file);
  const lots = Object.values(archive);
  result.vin = await enrichWithVinDecode({ lots, save: () => saveSoldArchive(file, archive), log, ...vinOptions });
  for (const lot of lots) {
    if (fillAttributes(lot) > 0)
      result.flags += 1;
  }
  saveSoldArchive(file, archive);
  log(`BRONVERA Rare: доработка новых лотов ${key}: ${JSON.stringify(result)}`);
  return result;
};

/*
 * Запуск доработки отдельным процессом; ждём завершения, чтобы суточный заход не накладывался сам на себя. Ошибка не валит заход.
 * Источники стартуют вместе (при запуске сервиса), поэтому процессы идут по очереди — иначе пять разборов разом съели бы память.
 */
let queue = Promise.resolve();
const runFinishInChild = (key, log = console.log) => {
  const run = queue.then(() => spawnFinish(key, log));
  queue = run.catch(() => {});
  return run;
};

const spawnFinish = (key, log) => new Promise((resolve) => {
  const script = path.join(__dirname, "..", "..", "scripts", "finish-new-sold.js");
  const child = spawn(process.execPath, ["--max-old-space-size=1100", script, key], { cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (error) => {
    log(`BRONVERA Rare: не запустил доработку новых лотов ${key}: ${error.message}`);
    resolve(false);
  });
  child.on("exit", (code) => {
    if (code !== 0)
      log(`BRONVERA Rare: доработка новых лотов ${key} закончилась с кодом ${code}`);
    resolve(code === 0);
  });
});

module.exports = { SOURCES, finishNewSold, runFinishInChild };
