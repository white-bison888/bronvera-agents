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
/*
 * 07.10.2026 архив BaT (71 511 лотов) был потерян: перезапуск службы попал на
 * запись файла, он остался обрезанным, чтение молча вернуло «пусто», и суточный
 * заход записал архив с нуля. Поэтому: нет файла — архив пуст (первый запуск);
 * файл есть, но не читается — это ошибка, а не пустой архив.
 */
const loadSoldArchive = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  }
  catch (error) {
    if (error.code === "ENOENT")
      return {};
    throw error;
  }
  try {
    return JSON.parse(text);
  }
  catch (error) {
    throw new Error(`Архив ${file} повреждён (${text.length} знаков): ${error.message}. Не перезаписываю — восстановите файл из копии.`);
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

/*
 * Запись через временный файл и переименование: файл на месте всегда целый —
 * либо прежний, либо новый, обрезанным он не останется. Архив только копится,
 * поэтому резкое уменьшение (вдвое и больше у файла крупнее SHRINK_GUARD_BYTES)
 * считаем сбоем и не записываем; разовая чистка передаёт allowShrink.
 */
const SHRINK_GUARD_BYTES = 1024 * 1024;

const saveSoldArchive = (file, archive, { allowShrink = false } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Без отступов: у BaT десятки тысяч лотов, красивое форматирование удваивало бы файл.
  const text = JSON.stringify(archive);

  if (!allowShrink) {
    let before = 0;
    try {
      before = fs.statSync(file).size;
    }
    catch {}
    if (before > SHRINK_GUARD_BYTES && Buffer.byteLength(text) < before / 2)
      throw new Error(`Архив ${file} уменьшился бы с ${before} до ${Buffer.byteLength(text)} байт — не записываю.`);
  }

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};

/* Год — первый найденный токен 19xx/20xx в заголовке, как и у guessMake/guessModel. */
const yearFromTitle = (title) => {
  const text = String(title || "");
  const match = text.match(/\b(19|20)\d{2}\b/);
  if (match)
    return Number(match[0]);
  // «383-Powered '32 Ford Roadster» — год записан двумя цифрами; на BaT такие лоты старинные, считаем 19xx.
  const short = text.match(/['\u2019](\d{2})\b/);
  return short ? 1900 + Number(short[1]) : null;
};

/*
 * Пока идёт долгий разовый добор данных (страницы лотов — часы), он держит архив
 * в памяти и записывает его целиком. Если в это время сервис сделает свой
 * суточный заход и тоже запишет архив, чья-то работа затрётся. Файл sold.lock
 * рядом с архивом говорит сервису: не трогай архив, пока он лежит.
 */
const soldArchiveLocked = dataDir => fs.existsSync(path.join(dataDir, "sold.lock"));

module.exports = { soldArchiveLocked, loadSoldArchive, readSoldArchiveCached, saveSoldArchive, yearFromTitle };
