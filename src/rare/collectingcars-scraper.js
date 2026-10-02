const fs = require("fs");
const path = require("path");
const { guessMake, guessModel } = require("./title-parser");
const { loadSoldArchive, readSoldArchiveCached, saveSoldArchive, soldArchiveLocked, yearFromTitle } = require("./sold-archive");
const { FxRates, reconvertArchive } = require("./fx");
const { parseMileageText, transmissionKind } = require("./sold-fields");
const { describeTransmission } = require("./transmission");
const { engineOf, parseVehicleAttributes } = require("./sold-attrs");
const { applyPatch } = require("./sold-pages");

/*
 * BRONVERA Rare, Фаза 3 (01.10.2026): шестая площадка — Collecting Cars.
 * Сам collectingcars.com закрыт Cloudflare managed-challenge для адреса
 * дата-центра, поэтому первая версия открывала /buy в браузере через
 * резидентный прокси и разбирала текст карточек (и успевала подгрузить
 * только ~50 лотов из ~150). 02.10.2026 нашли, что сами страницы /buy и
 * /sold берут данные из открытого поиска (Typesense,
 * dora.production.collecting.com) с поисковым ключом фронтенда — он виден
 * в любом запросе браузера к сайту, это не учётная запись. Запросы идут
 * напрямую, без браузера и прокси, и отдают всё сразу: точное время
 * закрытия, ставку, валюту, фото.
 *
 * Лоты из разных стран (UK, Австралия, Новая Зеландия, США, Европа) —
 * цена у каждого в своей валюте. Переводим в USD по курсу (как eurUsd в
 * costs/prices.js — фиксированный на дату, не живой; обновлять вручную,
 * если сильно разойдётся).
 */

const SEARCH_URL = "https://dora.production.collecting.com/multi_search";
const SEARCH_KEY = "0I2WvLvRUeeHNaDV74u0KRlkLnhhgH9S";
const CLOSING_SOON_MS = 48 * 3600 * 1000;
const LIVE_PER_PAGE = 250;
const LIVE_MAX_PAGES = 10;
const SOLD_PER_PAGE = 250;
const SOLD_MAX_PAGES = 4; // потолок на один ежедневный заход (CC продаёт ~100 машин в день); разовое добавление истории — maxPages побольше, stopWhenKnown: false

// Курс ЕЦБ/api.frankfurter.dev на 01.10.2026, см. costs/prices.js (eurUsd) — тот же источник, не обновляется сам.
const FX_BY_CODE = {
  usd: 1,
  gbp: 1.32338, // 1 / 0.75565 GBP
  eur: 1.12979, // 1 / 0.88511 EUR
  aud: 0.69505, // 1 / 1.4388 AUD
  nzd: 0.56153, // 1 / 1.7809 NZD
  chf: 1.1972, // 1 / 0.83528 CHF
};

const toUsd = (amount, currencyCode) => {
  const rate = FX_BY_CODE[String(currencyCode || "").toLowerCase()];
  if (!rate || typeof amount !== "number")
    return null;
  return Math.round(amount * rate);
};

// CDN отдаёт оригинал на ~2 МБ; параметры w/q (те же, что ставит сам сайт) сжимают до ~150 КБ.
const photoOf = url => (url ? `${url}?w=1280&q=75` : null);

// «2026-10-02 06:47:24» (UTC, без пояса) → ISO.
const utcIso = (value) => {
  if (!value)
    return null;
  const ms = Date.parse(`${String(value).replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/*
 * Тот же принцип, что у Cars & Bids/Hemmings (баг от Mikita 01.10.2026):
 * доверяем стадии самой площадки. Раз индекс ещё называет лот live, а
 * расписанное время вышло — торги продлились, это «closing», не «ended».
 */
const statusOf = (closesAt, now) => {
  if (!closesAt)
    return "open";
  const end = Date.parse(closesAt);
  if (!Number.isFinite(end))
    return "open";
  if (end - now <= CLOSING_SOON_MS)
    return "closing";
  return "open";
};

const LIVE_FIELDS = "slug,title,mainImageUrl,currencyCode,currentBid,dtStageEndsUTC,productMake,modelName";
const SOLD_FIELDS = "slug,title,mainImageUrl,currencyCode,priceSold,isSoldPriceHidden,productMake,productYear,modelName,dtSoldUTC,features,powertrainName,variantName,generationName,driveSide";

const toRareLot = (doc, now) => {
  const make = doc.productMake || guessMake(doc.title);
  const closesAt = utcIso(doc.dtStageEndsUTC);

  return {
    id: `collectingcars-${doc.slug}`,
    title: doc.title,
    make,
    model: guessModel(doc.title, make) || doc.modelName || null,
    source: "Collecting Cars",
    sourceUrl: `https://collectingcars.com/for-sale/${doc.slug}`,
    mileage: null, // в индексе нет — иногда в самом заголовке, ненадёжно вытаскивать
    transmission: null,
    vin: null,
    ownerType: null,
    estimateMin: null, // площадка оценок не даёт, только текущую ставку
    estimateMax: null,
    currentBid: toUsd(doc.currentBid, doc.currencyCode),
    closesAt,
    status: statusOf(closesAt, now),
    photoUrl: photoOf(doc.mainImageUrl),
  };
};

/*
 * Вкладка Stats (02.10.2026, просьба Mikita): проданные лоты. В индексе
 * нет стадии «не продан», только подтверждённые продажи. Цена приходит в
 * валюте лота: в архиве храним её как есть (salePriceLocal + currency), а
 * salePrice в USD считаем по курсу ЕЦБ на день продажи (см. fx.js) —
 * сегодняшним курсом старые лоты пересчитывать нельзя.
 */
const SOLD_CURRENCIES = new Set(Object.keys(FX_BY_CODE).map(code => code.toUpperCase()));

/* Двигатель из поля powertrainName («3.8L Twin-Turbocharged H6») — точнее, чем догадка по названию лота. */
const engineFromPowertrain = (powertrainName) => {
  const engine = engineOf(powertrainName);
  return Object.fromEntries(Object.entries(engine).filter(([, value]) => value !== null));
};

const toSoldLot = (doc) => {
  const currency = String(doc.currencyCode || "").toUpperCase();
  const soldAt = utcIso(doc.dtSoldUTC);
  if (doc.isSoldPriceHidden || typeof doc.priceSold !== "number" || !SOLD_CURRENCIES.has(currency) || !soldAt)
    return null;

  const make = doc.productMake || guessMake(doc.title);
  const year = Number(doc.productYear);

  return {
    id: `collectingcars-${doc.slug}`,
    title: doc.title,
    make,
    model: guessModel(doc.title, make) || doc.modelName || null,
    year: Number.isFinite(year) && year > 1800 ? year : yearFromTitle(doc.title),
    source: "Collecting Cars",
    sourceUrl: `https://collectingcars.com/for-sale/${doc.slug}`,
    soldAt,
    salePrice: null, // подставляется по курсу на день продажи
    salePriceLocal: doc.priceSold,
    currency,
    sold: true,
    estimateMin: null,
    estimateMax: null,
    // В поле features карточки: mileage «64,500 Miles» или «25,660 Km», transmission «Manual»/«Automatic»; цвета в индексе нет.
    mileage: parseMileageText(doc.features?.mileage),
    transmission: describeTransmission(doc.features?.transmission),
    transmissionKind: transmissionKind(doc.features?.transmission),
    // Таксономия самой площадки: поколение («997.2»), вариант («Turbo S») и двигатель («3.8L Twin-Turbocharged H6»).
    ...(doc.generationName ? { generation: doc.generationName } : {}),
    ...(doc.variantName ? { trimName: doc.variantName } : {}),
    ...(doc.powertrainName ? { powertrain: doc.powertrainName } : {}),
    ...parseVehicleAttributes(doc.title),
    ...engineFromPowertrain(doc.powertrainName),
    ...(doc.driveSide === "left" ? { steering: "Левый" } : (doc.driveSide === "right" ? { steering: "Правый" } : {})),
    conditionFacts: [],
    photoUrl: photoOf(doc.mainImageUrl),
  };
};

class CollectingCarsScraper {
  constructor({
    dataDir = path.join(process.cwd(), "data", "rare", "collectingcars"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null,
    fetchImpl = fetch,
    fx = new FxRates({ file: path.join(dataDir, "..", "fx-rates.json") }),
  } = {}) {
    Object.assign(this, { dataDir, now, log, alerts, fetchImpl, fx });
  }

  lotsFile() {
    return path.join(this.dataDir, "lots.json");
  }

  soldFile() {
    return path.join(this.dataDir, "sold.json");
  }

  statusFile() {
    return path.join(this.dataDir, "status.json");
  }

  writeStatus(status) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.statusFile(), JSON.stringify(status, null, 2));
  }

  readStatus() {
    try {
      return JSON.parse(fs.readFileSync(this.statusFile(), "utf8"));
    }
    catch {
      return { source: "Collecting Cars", lastRunAt: null, ok: null, count: null, error: null };
    }
  }

  readLots() {
    try {
      return JSON.parse(fs.readFileSync(this.lotsFile(), "utf8"));
    }
    catch {
      return { updatedAt: null, source: "Collecting Cars", count: 0, lots: [] };
    }
  }

  readSold() {
    return Object.values(readSoldArchiveCached(this.soldFile()));
  }

  /*
   * Только машины (не номера, запчасти, мотоциклы) и только аукционы (не
   * «купить сейчас»). Возвращает документы страницы и общее число найденных.
   */
  async search({ stage, sortBy, fields, page, perPage }) {
    const response = await this.fetchImpl(`${SEARCH_URL}?x-typesense-api-key=${SEARCH_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searches: [{
          collection: "production_listings",
          q: "*",
          query_by: "title",
          include_fields: fields,
          filter_by: `(listingStage:${stage}) && sites:=cars && lotType:car && saleFormat:auction`,
          sort_by: sortBy,
          page,
          per_page: perPage,
        }],
      }),
    });

    if (!response.ok)
      throw new Error(`Collecting Cars (${stage}, страница ${page}) ответил ${response.status}`);

    const result = (await response.json()).results?.[0];

    if (result?.error)
      throw new Error(`Collecting Cars (${stage}): ${result.error}`);

    return { docs: (result?.hits || []).map(hit => hit.document), found: result?.found || 0 };
  }

  async fetchLiveDocs() {
    const all = [];

    for (let page = 1; page <= LIVE_MAX_PAGES; page += 1) {
      const { docs, found } = await this.search({ stage: "live", sortBy: "dtStageEndsUTC:asc", fields: LIVE_FIELDS, page, perPage: LIVE_PER_PAGE });
      all.push(...docs);
      if (docs.length < LIVE_PER_PAGE || all.length >= found)
        break;
    }

    return all;
  }

  /*
   * Выдача идёт от свежих продаж к старым: листаем, пока на странице есть
   * хоть один лот, которого ещё нет в архиве, — полностью знакомая
   * страница значит, что дальше всё уже собрано.
   */
  async updateSoldArchive({ maxPages = SOLD_MAX_PAGES, stopWhenKnown = true } = {}) {
    const archive = loadSoldArchive(this.soldFile());
    let added = 0;
    let enriched = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      const { docs } = await this.search({ stage: "sold", sortBy: "tsSoldUTC:desc", fields: SOLD_FIELDS, page, perPage: SOLD_PER_PAGE });
      let newOnPage = 0;

      for (const doc of docs) {
        const soldLot = toSoldLot(doc);
        if (!soldLot)
          continue;
        if (archive[soldLot.id]) {
          // Уже в архиве — дописываем новые поля (комплектация, двигатель, привод), не трогая известное и цену.
          const { id, salePrice, soldAt, salePriceLocal, currency, sold, ...details } = soldLot;
          if (applyPatch(archive[soldLot.id], details) > 0)
            enriched += 1;
          continue;
        }
        try {
          Object.assign(soldLot, await this.fx.convert(soldLot.salePriceLocal, soldLot.currency, soldLot.soldAt));
        }
        catch (error) {
          this.log(`BRONVERA Rare: не пересчитал ${soldLot.id} по курсу на дату продажи: ${error.message}`);
          continue; // попробуем снова в следующий заход — без цены в долларах лот в статистику не берём
        }
        archive[soldLot.id] = soldLot;
        newOnPage += 1;
      }

      added += newOnPage;

      if (docs.length < SOLD_PER_PAGE || (stopWhenKnown && newOnPage === 0))
        break;
    }

    const reconverted = await reconvertArchive(archive, this.fx, this.log);

    if (added > 0 || reconverted > 0 || enriched > 0) {
      saveSoldArchive(this.soldFile(), archive);
      this.log(`BRONVERA Rare: добавил ${added} проданных лотов Collecting Cars в архив (всего ${Object.keys(archive).length}, дополнил полями ${enriched})`);
    }

    return added;
  }

  async run() {
    const now = this.now();
    const previousIds = new Set(this.readLots().lots.map(lot => lot.id));

    try {
      const docs = await this.fetchLiveDocs();
      const lots = docs
        .map(doc => toRareLot(doc, now))
        .filter(lot => lot.currentBid !== null); // валюта без курса или без ставки — сумму не угадываем

      this.log(`BRONVERA Rare: собрано ${lots.length} лотов с Collecting Cars`);

      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.lotsFile(),
        JSON.stringify({ updatedAt: new Date(now).toISOString(), source: "Collecting Cars", count: lots.length, lots }, null, 2),
      );

      this.writeStatus({ source: "Collecting Cars", lastRunAt: new Date(now).toISOString(), ok: true, count: lots.length, error: null });

      if (!soldArchiveLocked(this.dataDir))
        await this.updateSoldArchive().catch(error => this.log("BRONVERA Rare: не добрал архив продаж Collecting Cars:", error.message));

      if (this.alerts) {
        const newLots = lots.filter(lot => !previousIds.has(lot.id));
        const allLotsById = new Map(lots.map(lot => [lot.id, lot]));
        await this.alerts.checkAfterRun({ newLots, allLotsById }).catch(error => this.log("BRONVERA Rare: ошибка алертов (Collecting Cars):", error.message));
      }

      return lots;
    }
    catch (error) {
      this.writeStatus({ source: "Collecting Cars", lastRunAt: new Date(now).toISOString(), ok: false, count: null, error: error.message });
      throw error;
    }
  }

  start(intervalMs = 24 * 3600 * 1000) {
    if (this.timer)
      return;

    const tick = () => this.run().catch(error => console.error("CollectingCarsScraper error:", error.message));

    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = CollectingCarsScraper;
