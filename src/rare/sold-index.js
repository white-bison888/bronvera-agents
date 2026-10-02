const fs = require("fs");
const { engineLabel } = require("./sold-attrs");
const { buildFamilyResolver } = require("./model-family");

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

/*
 * Порядок первых 11 колонок не меняем — по ним читает уже выложенный сайт.
 * Колонка «model» теперь несёт линейку (family: «911», «Grand Cherokee»), а
 * остаток названия — комплектация — идёт отдельной колонкой trim (см.
 * model-family.js). Новые колонки только в конце.
 */
const POINT_FIELDS = ["id", "soldAt", "salePrice", "source", "make", "model", "year", "mileage", "transmission", "color", "sold", "body", "engine", "drive", "trim", "generation"];
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
    this.resolveFamily = buildFamilyResolver(lots);
    this.signature = signature;
  }

  total() {
    this.refresh();
    return this.lots.length;
  }

  /* [since, until) в миллисекундах; null — без границы. */
  points({ since = null, until = null } = {}) {
    this.refresh();

    const dict = { source: [], make: [], model: [], color: [], body: [], engine: [], drive: [], trim: [], generation: [] };
    const lookup = { source: new Map(), make: new Map(), model: new Map(), color: new Map(), body: new Map(), engine: new Map(), drive: new Map(), trim: new Map(), generation: new Map() };
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
      const { family, trim, generation } = this.resolveFamily(lot);
      rows.push([
        lot.id,
        Math.floor(at / 1000),
        lot.salePrice,
        code("source", lot.source),
        code("make", lot.make),
        code("model", family),
        typeof lot.year === "number" ? lot.year : 0,
        typeof lot.mileage === "number" ? lot.mileage : -1,
        TRANSMISSION_CODES[lot.transmissionKind] || 0,
        code("color", lot.colorGroup),
        lot.sold === true ? 1 : (lot.sold === false ? 0 : 2),
        code("body", lot.bodyStyle),
        code("engine", engineLabel(lot)),
        code("drive", lot.drivetrain),
        code("trim", lot.trimName || trim),
        code("generation", lot.generation || generation),
      ]);
    }

    return { fields: POINT_FIELDS, dict, rows };
  }

  lotsByIds(ids) {
    this.refresh();
    return ids.map(id => this.byId.get(id)).filter(Boolean).map(fullLot);
  }

  /*
   * «Равные позиции» (просьба Mikita): с чем честно сравнивать цену этого
   * лота. Берём продажи той же линейки модели и сужаем по признакам от
   * важных к менее важным: комплектация, кузов, коробка, двигатель, годы
   * выпуска ±3, пробег. Если подходящих меньше minCount, признаки снимаем
   * по одному с конца списка (первым — пробег, потом годы…) и честно
   * говорим, какие сняли. Возвращает критерии, статистику и самые свежие продажи.
   */
  comparables(id, { minCount = 8, listSize = 12 } = {}) {
    this.refresh();
    const lot = this.byId.get(id);
    if (!lot)
      return null;

    const resolved = this.resolveFamily(lot);
    const mine = { ...resolved, trim: lot.trimName || resolved.trim, generation: lot.generation || resolved.generation };
    const generationOf = other => other.generation || this.resolveFamily(other).generation;
    const sameLine = other => other.id !== lot.id && other.make === lot.make && other.sold !== false && this.resolveFamily(other).family === mine.family;
    const pool = mine.family ? this.lots.filter(sameLine) : [];

    const mileageBand = (miles) => {
      for (const limit of [5000, 10000, 25000, 50000, 75000, 100000, 150000]) {
        if (miles < limit)
          return limit;
      }
      return Infinity;
    };

    // Критерии от самых важных к менее важным; у каждого — подпись и проверка. Критерий без данных у самого лота пропускаем.
    const criteria = [
      { key: "generation", label: mine.generation ? `поколение ${mine.generation}` : null, use: Boolean(mine.generation), test: o => generationOf(o) === mine.generation },
      { key: "trim", label: mine.trim, use: Boolean(mine.trim), test: o => (o.trimName || this.resolveFamily(o).trim) === mine.trim },
      { key: "body", label: lot.bodyStyle, use: Boolean(lot.bodyStyle), test: o => o.bodyStyle === lot.bodyStyle },
      { key: "transmission", label: lot.transmissionKind === "manual" ? "механика" : "автомат", use: Boolean(lot.transmissionKind), test: o => o.transmissionKind === lot.transmissionKind },
      { key: "engine", label: engineLabel(lot), use: Boolean(engineLabel(lot)), test: o => engineLabel(o) === engineLabel(lot) },
      { key: "years", label: typeof lot.year === "number" ? `${lot.year - 3}–${lot.year + 3} гг.` : null, use: typeof lot.year === "number", test: o => typeof o.year === "number" && Math.abs(o.year - lot.year) <= 3 },
      { key: "mileage", label: typeof lot.mileage === "number" ? "близкий пробег" : null, use: typeof lot.mileage === "number", test: o => typeof o.mileage === "number" && mileageBand(o.mileage) === mileageBand(lot.mileage) },
    ].filter(item => item.use);

    /*
     * Поколение и комплектация — ядро позиции: без них это уже другая машина
     * (997 Turbo и 996 Carrera — разные цены), поэтому их не снимаем никогда,
     * даже если совпадений мало. Остальные признаки снимаем по одному с конца
     * (пробег, годы, двигатель, коробка, кузов), пока не наберётся minCount.
     */
    const core = criteria.filter(item => item.key === "generation" || item.key === "trim");
    const soft = criteria.filter(item => item.key !== "generation" && item.key !== "trim");
    let activeSoft = soft;
    const matchFor = list => pool.filter(other => [...core, ...list].every(item => item.test(other)));
    let matches = matchFor(activeSoft);
    const dropped = [];
    while (matches.length < minCount && activeSoft.length > 0) {
      dropped.push(activeSoft[activeSoft.length - 1]);
      activeSoft = activeSoft.slice(0, -1);
      matches = matchFor(activeSoft);
    }
    const active = [...core, ...activeSoft];

    const prices = matches.map(other => other.salePrice).sort((a, b) => a - b);
    const at = q => (prices.length ? prices[Math.min(prices.length - 1, Math.floor((prices.length - 1) * q))] : null);

    return {
      line: mine.family ? `${lot.make} ${mine.family}` : null,
      criteria: active.map(item => item.label),
      relaxed: dropped.map(item => item.label),
      count: matches.length,
      thin: matches.length < minCount,
      median: at(0.5),
      low: at(0.25),
      high: at(0.75),
      lots: matches.slice(0, listSize).map(fullLot),
    };
  }

  lot(id) {
    this.refresh();
    const lot = this.byId.get(id);
    return lot ? fullLot(lot) : null;
  }
}

module.exports = { SoldIndex, fullLot, POINT_FIELDS };
