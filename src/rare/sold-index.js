const fs = require("fs");

/*
 * Индекс проданных лотов для вкладки Stats (02.10.2026). Архивов уже
 * десятки тысяч лотов, и отдавать сайту каждый целиком (с названием, ссылками
 * и фото — около 700 байт) нельзя: ответ через Vercel не может быть больше
 * ~4,5 МБ, а графикам и фильтрам эти поля не нужны. Поэтому два вида ответа:
 *
 *   points  — компактные строки-массивы только с тем, что нужно графикам,
 *             фильтрам и сводке (цена, дата, марка, модель, год, пробег,
 *             коробка, цвет), повторяющиеся слова — через словари;
 *   lotsByIds — полные записи для строк списка на экране и выгрузки в CSV.
 *
 * Индекс пересобирается только когда меняется файл любого архива.
 */

const POINT_FIELDS = ["id", "soldAt", "salePrice", "source", "make", "model", "year", "mileage", "transmission", "color", "sold"];
const TRANSMISSION_CODES = { manual: 1, automatic: 2 };

/* Всё, что страница ждёт от лота, — с пустыми значениями по умолчанию (старые записи архива их не имеют). */
const fullLot = lot => ({
  estimateMin: null,
  estimateMax: null,
  mileage: null,
  transmission: null,
  transmissionKind: null,
  exteriorColor: null,
  colorGroup: null,
  conditionFacts: [],
  photoUrl: null,
  year: null,
  model: null,
  sold: null,
  ...lot,
});

const signatureOf = (files) => {
  return files.map((file) => {
    try {
      const { mtimeMs, size } = fs.statSync(file);
      return `${file}:${mtimeMs}:${size}`;
    }
    catch {
      return `${file}:0`;
    }
  }).join("|");
};

class SoldIndex {
  constructor(scrapers) {
    this.scrapers = scrapers;
    this.signature = null;
    this.lots = [];
    this.byId = new Map();
  }

  refresh() {
    const sources = this.scrapers.filter(scraper => typeof scraper.readSold === "function" && typeof scraper.soldFile === "function");
    const signature = signatureOf(sources.map(scraper => scraper.soldFile()));
    if (signature === this.signature)
      return;

    const lots = sources
      .flatMap(scraper => scraper.readSold())
      .filter(lot => lot && lot.soldAt && typeof lot.salePrice === "number")
      .sort((a, b) => Date.parse(b.soldAt) - Date.parse(a.soldAt));

    this.lots = lots;
    this.byId = new Map(lots.map(lot => [lot.id, lot]));
    this.signature = signature;
  }

  total() {
    this.refresh();
    return this.lots.length;
  }

  /* [since, until) в миллисекундах; null — без границы. */
  points({ since = null, until = null } = {}) {
    this.refresh();

    const dict = { source: [], make: [], model: [], color: [] };
    const lookup = { source: new Map(), make: new Map(), model: new Map(), color: new Map() };
    const code = (kind, value) => {
      if (value === null || value === undefined || value === "")
        return -1;
      const known = lookup[kind].get(value);
      if (known !== undefined)
        return known;
      dict[kind].push(value);
      lookup[kind].set(value, dict[kind].length - 1);
      return dict[kind].length - 1;
    };

    const rows = [];
    for (const lot of this.lots) {
      const at = Date.parse(lot.soldAt);
      if ((since !== null && at < since) || (until !== null && at >= until))
        continue;
      rows.push([
        lot.id,
        Math.floor(at / 1000),
        lot.salePrice,
        code("source", lot.source),
        code("make", lot.make),
        code("model", lot.model),
        typeof lot.year === "number" ? lot.year : 0,
        typeof lot.mileage === "number" ? lot.mileage : -1,
        TRANSMISSION_CODES[lot.transmissionKind] || 0,
        code("color", lot.colorGroup),
        lot.sold === true ? 1 : (lot.sold === false ? 0 : 2),
      ]);
    }

    return { fields: POINT_FIELDS, dict, rows };
  }

  lotsByIds(ids) {
    this.refresh();
    return ids.map(id => this.byId.get(id)).filter(Boolean).map(fullLot);
  }

  lot(id) {
    this.refresh();
    const lot = this.byId.get(id);
    return lot ? fullLot(lot) : null;
  }
}

module.exports = { SoldIndex, fullLot, POINT_FIELDS };
