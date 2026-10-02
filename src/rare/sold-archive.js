const fs = require("fs");
const path = require("path");

/*
 * Вкладка Stats на сайте (01.10.2026, просьба Mikita): реальная история
 * проданных лотов вместо примерных данных. В отличие от lots.json
 * (активные лоты — весь файл перезаписывается на каждом прогоне), архив
 * проданных копится: каждый лот добавляется один раз, когда впервые
 * увидели его цену закрытия, и остаётся навсегда — иначе, как выяснилось
 * на BaT, лот пропадает из выдачи площадки в течение суток и Stats теряет
 * его безвозвратно.
 */
const loadSoldArchive = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  catch {
    return {};
  }
};

/*
 * Чтение для сайта: /api/rare/sold дёргают несколько раз подряд (период
 * «весь архив» грузится кусками), а файл у RM Sotheby's ~8 МБ — не разбираем
 * его заново на каждый запрос, пока файл не менялся. Изменять результат нельзя.
 */
const readCache = new Map();

const readSoldArchiveCached = (file) => {
  try {
    const { mtimeMs, size } = fs.statSync(file);
    const hit = readCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size)
      return hit.archive;
    const archive = loadSoldArchive(file);
    readCache.set(file, { mtimeMs, size, archive });
    return archive;
  }
  catch {
    return {};
  }
};

const saveSoldArchive = (file, archive) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(archive, null, 2));
};

/* Год — первый найденный токен 19xx/20xx в заголовке, как и у guessMake/guessModel. */
const yearFromTitle = (title) => {
  const match = String(title || "").match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
};

module.exports = { loadSoldArchive, readSoldArchiveCached, saveSoldArchive, yearFromTitle };
