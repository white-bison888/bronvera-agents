const fs = require("fs");
const path = require("path");

/*
 * Курсы валют на дату продажи (02.10.2026, просьба Mikita): лот 2005 года
 * нельзя пересчитывать по сегодняшнему курсу — статистика цен исказится.
 * Источник — api.frankfurter.dev (бесплатный, без ключа, официальные
 * справочные курсы ЕЦБ с 04.01.1999). На выходные и праздники сервис сам
 * отдаёт курс последнего рабочего дня — в кэше храним и запрошенную дату,
 * и фактическую (rateDate), чтобы на сайте было видно, по какому дню считали.
 *
 * Кэш в файле: курс на прошедший день не меняется, второй раз за ним
 * в сеть не ходим. В кэше — «единиц валюты за 1 USD», как отдаёт сервис.
 */
const FRANKFURTER_URL = "https://api.frankfurter.dev/v1";
const SYMBOLS = ["GBP", "EUR", "AUD", "NZD", "CHF"];

class FxRates {
  constructor({
    file,
    fetchImpl = fetch,
    now = () => Date.now(),
  } = {}) {
    Object.assign(this, { file, fetchImpl, now });
    this.cache = null;
  }

  load() {
    if (this.cache)
      return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf8"));
    }
    catch {
      this.cache = {};
    }
    return this.cache;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache));
    fs.renameSync(tmp, this.file);
  }

  async fetchDay(date) {
    const query = `?base=USD&symbols=${SYMBOLS.join(",")}`;
    let response = await this.fetchImpl(`${FRANKFURTER_URL}/${date}${query}`);

    // Дата позже последней опубликованной (например, сегодняшняя утром) — берём последний доступный курс.
    if (response.status === 404 && Date.parse(`${date}T00:00:00Z`) > this.now() - 7 * 24 * 3600 * 1000)
      response = await this.fetchImpl(`${FRANKFURTER_URL}/latest${query}`);

    if (!response.ok)
      throw new Error(`курс на ${date} не получен: сервис ответил ${response.status}`);

    const data = await response.json();
    return { rateDate: data.date, perUsd: data.rates };
  }

  /*
   * Сколько USD стоит одна единица валюты на дату продажи (date — «ГГГГ-ММ-ДД»).
   * Возвращает { rate, rateDate }; бросает ошибку, если курса получить не удалось.
   */
  async usdPerUnit(currency, date) {
    const code = String(currency || "").toUpperCase();
    if (code === "USD")
      return { rate: 1, rateDate: date };

    const cache = this.load();
    if (!cache[date]) {
      cache[date] = await this.fetchDay(date);
      this.save();
    }

    const perUsd = cache[date].perUsd[code];
    if (!perUsd)
      throw new Error(`нет курса ${code} на ${date}`);

    return { rate: Math.round((1 / perUsd) * 1e6) / 1e6, rateDate: cache[date].rateDate };
  }

  /*
   * Цена в USD по курсу на день продажи. soldAt — ISO-время/дата, берём дату в UTC.
   * Возвращает { salePrice, fxRate, fxDate } или бросает ошибку.
   */
  async convert(amount, currency, soldAt) {
    const date = new Date(soldAt).toISOString().slice(0, 10);
    const { rate, rateDate } = await this.usdPerUnit(currency, date);
    return { salePrice: Math.round(amount * rate), fxRate: rate, fxDate: rateDate };
  }
}

/*
 * Пересчёт уже лежащих в архиве лотов, у которых нет курса на дату продажи
 * (записаны со старым фиксированным курсом). Лоты, для которых курс
 * достать не удалось, остаются как есть и попробуются в следующий заход.
 */
const reconvertArchive = async (archive, fx, log = () => {}) => {
  let changed = 0;
  let failed = 0;

  for (const lot of Object.values(archive)) {
    if (!lot.currency || lot.currency === "USD" || lot.fxDate || typeof lot.salePriceLocal !== "number" || !lot.soldAt)
      continue;
    try {
      Object.assign(lot, await fx.convert(lot.salePriceLocal, lot.currency, lot.soldAt));
      changed += 1;
    }
    catch (error) {
      failed += 1;
      if (failed === 1)
        log(`BRONVERA Rare: не пересчитал цену ${lot.id} по курсу на дату продажи: ${error.message}`);
    }
  }

  return changed;
};

module.exports = { FxRates, reconvertArchive };
