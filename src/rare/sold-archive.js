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

const saveSoldArchive = (file, archive) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(archive, null, 2));
};

/* Год — первый найденный токен 19xx/20xx в заголовке, как и у guessMake/guessModel. */
const yearFromTitle = (title) => {
  const match = String(title || "").match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
};

module.exports = { loadSoldArchive, saveSoldArchive, yearFromTitle };
