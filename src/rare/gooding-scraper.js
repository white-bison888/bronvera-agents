const fs = require("fs");
const path = require("path");
const { guessMake, guessModel, canonicalMake } = require("./title-parser");
const { loadSoldArchive, readSoldArchiveCached, saveSoldArchive, soldArchiveLocked, yearFromTitle } = require("./sold-archive");
const { FxRates, reconvertArchive } = require("./fx");
const { bodyStyleOf, parseVehicleAttributes } = require("./sold-attrs");
const { enrichFromPages } = require("./sold-pages");
const { classifyVin, colorGroupOf, parseRmText, transmissionKind } = require("./sold-fields");
const { describeTransmission } = require("./transmission");

/*
 * BRONVERA Rare: Gooding & Company (04.10.2026, просьба Mikita — подключить следующие площадки).
 *
 * Сайт собран на Gatsby: каждая страница отдаёт те же данные открытым статическим JSON
 * (/page-data/<путь>/page-data.json), без браузера, ключей и прокси; robots.txt разрешает всё.
 *   — /sitemap.xml: адреса всех аукционов (/auction/realized/<код> — прошедшие, /auction/<код> — будущие) и лотов;
 *   — страница прошедшего аукциона: валюта, даты торгов и все лоты с ценой продажи (salePrice, с комиссией покупателя,
 *     как у RM; у непроданных и снятых лотов — null), маркой, моделью и годом;
 *   — страница лота: номер шасси/VIN, пункты «highlights» и «specifications», оценка.
 *
 * Дата лота — последний день торгов аукциона (у лота своей даты нет), цена хранится в валюте торгов (salePriceLocal +
 * currency), а salePrice в USD считается по курсу ЕЦБ на день продажи — как у RM Sotheby's.
 * Мотоциклы, автомобилия и искусство из тех же «онлайн-аукционов» в архив не берём.
 */

const BASE_URL = "https://www.goodingco.com";
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`;
const IMAGE_BASE = "https://media.goodingco.com/image/upload/c_fill,g_auto,q_88,w_600";
const SOURCE = "Gooding & Company";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" };
const CLOSING_SOON_MS = 48 * 3600 * 1000;
const SETTLE_MS = 3 * 24 * 3600 * 1000; // через столько после последнего дня торгов итоги считаем окончательными
const MAX_AUCTIONS_PER_RUN = 60;
const NOT_CAR_AUCTION = /motorcycle|automobilia|art-collectibles|lifestyle/i;
// В онлайн-аукционах Gooding рядом с автомобилями идут мотоциклы и мотороллеры, в списке лотов тот же тип «Vehicle» — отсекаем по марке.
const MOTORCYCLE_MAKES = new Set([
  "ducati", "moto guzzi", "mv agusta", "vincent", "vincent hrd", "laverda", "benelli", "matchless", "norton", "bsa", "indian", "lambretta",
  "malanca", "f.b. mondial", "parilla", "magni", "dunstall", "terrot", "magnat-debon", "solex", "egli-honda", "piaggio", "harley-davidson",
  "brough superior", "cushman", "husqvarna", "yamaha", "kawasaki", "vespa", "bultaco", "ktm",
]);

const pageDataUrl = route => `${BASE_URL}/page-data/${route.replace(/^\/+|\/+$/g, "")}/page-data.json`;

/* «1966 Porsche 911 (FL26)» — метка распродажи в конце названия не часть модели. */
const cleanTitle = title => String(title || "").replace(/\s*\([A-Z]{2,3}\d{2}\)\s*$/, "").replace(/\s+/g, " ").trim();

const photoUrlOf = (item) => {
  const image = (item?.cloudinaryImagesCombined || item?.cloudinaryImages1 || [])[0];
  if (!image?.public_id)
    return null;
  return `${IMAGE_BASE}/v1/${image.public_id.split("/").map(encodeURIComponent).join("/")}`;
};

const statusOf = (closesAt, now) => {
  if (!closesAt)
    return "open";
  const end = Date.parse(closesAt);
  if (!Number.isFinite(end) || end <= now)
    return "ended";
  if (end - now <= CLOSING_SOON_MS)
    return "closing";
  return "open";
};

/*
 * Адреса из sitemap.xml: страницы итогов (/auction/realized/<код>) и страницы самих аукционов (/auction/<код>).
 * Страница итогов заведена и у будущих аукционов, поэтому «будущий» определяем не по адресу, а по дате торгов.
 */
const parseSitemap = (xml) => {
  const locs = [...String(xml || "").matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  const realized = new Set();
  const auctions = new Set();
  for (const loc of locs) {
    const past = loc.match(/\/auction\/realized\/([a-z0-9-]+)\/?$/i);
    if (past) {
      realized.add(past[1]);
      continue;
    }
    const page = loc.match(/\/auction\/([a-z0-9-]+)\/?$/i);
    if (page && page[1] !== "realized")
      auctions.add(page[1]);
  }
  return { realized: [...realized], auctions: [...auctions] };
};

/* Последний день торгов («2026-03-06T17:00-05:00» → 2026-03-06) и его момент для статуса. */
const auctionEnd = (auction) => {
  const days = (auction?.subEvents || []).filter(event => event.__typename === "ContentfulSubEventAuction" && event.endDate);
  if (!days.length)
    return { endDate: null, closesAt: null };
  const last = days.map(event => event.endDate).sort().pop();
  const closesAt = Number.isFinite(Date.parse(last)) ? new Date(last).toISOString() : null;
  return { endDate: last.slice(0, 10), closesAt };
};

const isVehicle = entry => !entry?.item || entry.item.__typename === "ContentfulVehicle";

const identityOf = (entry) => {
  const item = entry.item || {};
  const title = cleanTitle(item.title);
  const year = Number.isFinite(item.modelYear) ? item.modelYear : yearFromTitle(title);
  const make = canonicalMake((item.make?.name || guessMake(title)).trim());
  return { title, year, make, model: guessModel(title, make), item };
};

const toSoldLot = (entry, auction, code, endDate) => {
  if (!isVehicle(entry) || !endDate || !(entry.salePrice > 0))
    return null;
  const { title, year, make, model, item } = identityOf(entry);
  if (!year || !make || MOTORCYCLE_MAKES.has(make.toLowerCase()))
    return null; // без года — не автомобиль (запчасти, сувениры); мотоциклы — отдельный рынок

  return {
    id: `gooding-${entry.slug}`,
    title,
    make,
    model,
    year,
    source: SOURCE,
    sourceUrl: `${BASE_URL}/lot/${entry.slug}`,
    soldAt: `${endDate}T00:00:00.000Z`,
    salePrice: null, // подставляется по курсу на день продажи
    salePriceLocal: entry.salePrice,
    currency: auction.currency || "USD",
    auctionCode: code,
    lotNumber: entry.lotNumber ?? null,
    sold: true,
    estimateMin: null,
    estimateMax: null,
    mileage: null,
    transmission: null,
    conditionFacts: [],
    ...parseVehicleAttributes(title),
    photoUrl: photoUrlOf(item),
  };
};

const toRareLot = (entry, closesAt, now) => {
  const { title, make, model, item } = identityOf(entry);
  if (MOTORCYCLE_MAKES.has(make.toLowerCase()))
    return null;
  return {
    id: `gooding-${entry.slug}`,
    title,
    make,
    model,
    source: SOURCE,
    sourceUrl: `${BASE_URL}/lot/${entry.slug}`,
    mileage: null,
    transmission: null,
    vin: null, // подставляется из lot-details.json
    ownerType: null,
    estimateMin: null, // подставляется из lot-details.json, в USD
    estimateMax: null,
    currentBid: null, // торги по расписанию — живой ставки до аукциона нет
    closesAt,
    status: statusOf(closesAt, now),
    photoUrl: photoUrlOf(item),
  };
};

/* Все текстовые значения вложенного объекта (описание лота может прийти строкой или деревом Contentful). */
const textValues = (node, out = []) => {
  if (typeof node === "string")
    out.push(node);
  else if (Array.isArray(node))
    node.forEach(child => textValues(child, out));
  else if (node && typeof node === "object")
    Object.values(node).forEach(child => textValues(child, out));
  return out;
};

/*
 * Страница лота (page-data): номер шасси/VIN и текст «highlights» + «specifications» + примечание + описание.
 * Из текста — пробег, цвет, коробка, двигатель, привод; кузов — только по названию (в тексте упоминаются и чужие модели).
 */
const parseGoodingLotPage = (text, lot = {}) => {
  let node;
  try {
    node = JSON.parse(text)?.result?.data?.contentfulLot;
  }
  catch {
    return {};
  }
  if (!node)
    return {};
  const item = node.item || {};
  const chassis = classifyVin(item.chassis);
  const prose = [...(item.highlights || []), ...(item.specifications || []), item.note, ...textValues(node.description)].filter(Boolean).join(". ");
  if (!prose)
    return chassis;
  const found = parseRmText(prose);
  const attrs = parseVehicleAttributes(lot.title, prose);
  const bodyStyle = bodyStyleOf(lot.title);
  delete attrs.bodyStyle;
  return {
    ...chassis,
    mileage: found.mileage,
    exteriorColor: found.exteriorColor,
    colorGroup: colorGroupOf(found.exteriorColor),
    transmission: describeTransmission(found.transmissionRaw),
    transmissionKind: transmissionKind(found.transmissionRaw),
    ...(bodyStyle ? { bodyStyle } : {}),
    ...attrs,
  };
};

class GoodingScraper {
  constructor({
    fetchImpl = fetch,
    dataDir = path.join(process.cwd(), "data", "rare", "gooding"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null,
    fx = new FxRates({ file: path.join(dataDir, "..", "fx-rates.json") }),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    Object.assign(this, { fetchImpl, dataDir, now, log, alerts, fx, sleep });
  }

  lotsFile() { return path.join(this.dataDir, "lots.json"); }
  detailsFile() { return path.join(this.dataDir, "lot-details.json"); }
  soldFile() { return path.join(this.dataDir, "sold.json"); }
  soldAuctionsFile() { return path.join(this.dataDir, "sold-auctions.json"); }
  statusFile() { return path.join(this.dataDir, "status.json"); }

  readSold() {
    return Object.values(readSoldArchiveCached(this.soldFile()));
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
      return { source: SOURCE, lastRunAt: null, ok: null, count: null, error: null };
    }
  }

  readLots() {
    try {
      return JSON.parse(fs.readFileSync(this.lotsFile(), "utf8"));
    }
    catch {
      return { updatedAt: null, source: SOURCE, count: 0, lots: [] };
    }
  }

  loadDetailsCache() {
    try {
      return JSON.parse(fs.readFileSync(this.detailsFile(), "utf8"));
    }
    catch {
      return {};
    }
  }

  saveDetailsCache(cache) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.detailsFile(), JSON.stringify(cache, null, 2));
  }

  loadSoldAuctions() {
    try {
      return JSON.parse(fs.readFileSync(this.soldAuctionsFile(), "utf8"));
    }
    catch {
      return {};
    }
  }

  async fetchText(url) {
    const response = await this.fetchImpl(url, { headers: HEADERS });
    if (!response.ok)
      throw Object.assign(new Error(`${url} ответил ${response.status}`), { status: response.status });
    return response.text();
  }

  async fetchPageData(route) {
    return JSON.parse(await this.fetchText(pageDataUrl(route)));
  }

  async fetchSitemap() {
    return parseSitemap(await this.fetchText(SITEMAP_URL));
  }

  /* Будущие аукционы: лоты в каталоге уже есть, цены и ставок нет — оценка со страницы лота. */
  async fetchActiveListings() {
    const now = this.now();
    const { auctions } = await this.fetchSitemap();
    const settled = this.loadSoldAuctions();
    const lots = [];

    for (const code of auctions) {
      // Аукционы, итоги которых уже окончательно записаны, заново не открываем — без этого каждый заход читал бы все десятки страниц.
      if (NOT_CAR_AUCTION.test(code) || this.isSettled(settled[code], now))
        continue;
      try {
        const data = (await this.fetchPageData(`auction/${code}`)).result?.data;
        const { closesAt } = auctionEnd(data?.contentfulWebPageAuction?.auction);
        if (!closesAt || Date.parse(closesAt) <= now)
          continue;
        for (const edge of data.allContentfulLot?.edges || []) {
          const lot = edge.node?.slug && isVehicle(edge.node) ? toRareLot(edge.node, closesAt, now) : null;
          if (lot)
            lots.push(lot);
        }
        await this.sleep(300);
      }
      catch (error) {
        this.log(`BRONVERA Rare: не собрал Gooding ${code}: ${error.message}`);
      }
    }

    return lots;
  }

  /* Оценка и номер шасси со страницы лота; оценка — в валюте аукциона, в кэше — в USD. */
  async fetchLotDetails(lot) {
    const slug = lot.sourceUrl.split("/lot/")[1];
    const node = (await this.fetchPageData(`lot/${slug}`)).result?.data?.contentfulLot;
    if (!node)
      return { vin: null, estimateMin: null, estimateMax: null };
    const currency = node.auction?.currency || "USD";
    const date = new Date(this.now()).toISOString().slice(0, 10);
    const { rate } = await this.fx.usdPerUnit(currency, date);
    const usd = value => (Number.isFinite(value) && value > 0 ? Math.round(value * rate) : null);
    return { vin: node.item?.chassis || null, estimateMin: usd(node.lowEstimate), estimateMax: usd(node.highEstimate) };
  }

  async fetchMissingDetails(lots, cache, { delayMs = 350 } = {}) {
    const missing = lots.filter(lot => !cache[lot.id]);
    for (const lot of missing) {
      try {
        cache[lot.id] = await this.fetchLotDetails(lot);
      }
      catch (error) {
        this.log(`BRONVERA Rare: не разобрал страницу лота Gooding ${lot.id}: ${error.message}`);
        continue;
      }
      await this.sleep(delayMs);
    }
    if (missing.length)
      this.log(`BRONVERA Rare: добрал детали по ${missing.length} лотам Gooding (в кэше ${Object.keys(cache).length})`);
    return cache;
  }

  isSettled(entry, now) {
    if (!entry)
      return false;
    if (!entry.endDate)
      return true;
    const settledAt = Date.parse(`${entry.endDate}T23:59:59Z`) + SETTLE_MS;
    return now > settledAt && Date.parse(entry.checkedAt) > settledAt;
  }

  async updateSoldArchive({ maxAuctions = MAX_AUCTIONS_PER_RUN, delayMs = 400 } = {}) {
    const now = this.now();
    const archive = loadSoldArchive(this.soldFile());
    const auctions = this.loadSoldAuctions();
    const { realized } = await this.fetchSitemap();
    const pending = realized.filter(code => !NOT_CAR_AUCTION.test(code) && !this.isSettled(auctions[code], now)).slice(0, maxAuctions);
    let added = 0;

    for (const code of pending) {
      try {
        const auction = (await this.fetchPageData(`auction/realized/${code}`)).result?.data?.contentfulWebPageAuction?.auction;
        const { endDate } = auctionEnd(auction);
        // Торги ещё впереди (страница «realized» бывает заведена заранее) — ничего не берём и не «закрываем».
        if (!auction || !endDate || Date.parse(`${endDate}T23:59:59Z`) > now) {
          await this.sleep(delayMs);
          continue;
        }

        let skippedForFx = 0;
        for (const entry of auction.lot || []) {
          const soldLot = toSoldLot(entry, auction, code, endDate);
          if (!soldLot)
            continue;
          if (archive[soldLot.id] && archive[soldLot.id].auctionCode === code)
            continue;
          if (archive[soldLot.id])
            soldLot.id = `${soldLot.id}-${code}`; // тот же номер в адресе, но другой аукцион: машину продавали повторно
          if (archive[soldLot.id])
            continue;
          try {
            Object.assign(soldLot, await this.fx.convert(soldLot.salePriceLocal, soldLot.currency, soldLot.soldAt));
          }
          catch (error) {
            skippedForFx += 1;
            if (skippedForFx === 1)
              this.log(`BRONVERA Rare: не пересчитал цены Gooding ${code} по курсу на дату продажи: ${error.message}`);
            continue;
          }
          archive[soldLot.id] = soldLot;
          added += 1;
        }

        if (skippedForFx === 0)
          auctions[code] = { endDate, checkedAt: new Date(now).toISOString() };
        await this.sleep(delayMs);
      }
      catch (error) {
        this.log(`BRONVERA Rare: не собрал итоги Gooding ${code}: ${error.message}`);
        if (error.status === 404)
          auctions[code] = { endDate: null, checkedAt: new Date(now).toISOString() };
      }
    }

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.soldAuctionsFile(), JSON.stringify(auctions, null, 2));

    const reconverted = await reconvertArchive(archive, this.fx, this.log);
    if (added > 0 || reconverted > 0) {
      saveSoldArchive(this.soldFile(), archive);
      this.log(`BRONVERA Rare: добавил ${added} проданных лотов Gooding в архив (всего ${Object.keys(archive).length})`);
    }
    return added;
  }

  /* Дописывает проданным лотам номер шасси/VIN, пробег, цвет, коробку и двигатель со страницы лота. */
  async enrichSoldFromPages({ limit = Infinity, delayMs = 350, concurrency = 1 } = {}) {
    const archive = loadSoldArchive(this.soldFile());
    const lots = Object.values(archive).filter(lot => lot.sourceUrl).sort((a, b) => b.salePrice - a.salePrice);

    return enrichFromPages({
      lots,
      limit,
      delayMs,
      concurrency,
      sleep: this.sleep,
      now: this.now,
      log: this.log,
      label: SOURCE,
      save: () => saveSoldArchive(this.soldFile(), archive),
      fetchHtml: async (lot) => {
        const response = await this.fetchImpl(pageDataUrl(`lot/${lot.sourceUrl.split("/lot/")[1]}`), { headers: HEADERS });
        if (response.status === 404)
          return null;
        if (!response.ok)
          throw new Error(`страница ответила ${response.status}`);
        return response.text();
      },
      parse: (text, lot) => parseGoodingLotPage(text, lot),
    });
  }

  async run() {
    const now = this.now();
    const previousIds = new Set(this.readLots().lots.map(lot => lot.id));

    try {
      const lots = await this.fetchActiveListings();
      this.log(`BRONVERA Rare: собрано ${lots.length} лотов с Gooding & Company`);

      const detailsCache = await this.fetchMissingDetails(lots, this.loadDetailsCache());
      this.saveDetailsCache(detailsCache);
      const enriched = lots.map(lot => ({ ...lot, ...(detailsCache[lot.id] || {}) }));

      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.lotsFile(), JSON.stringify({ updatedAt: new Date(now).toISOString(), source: SOURCE, count: enriched.length, lots: enriched }, null, 2));
      this.writeStatus({ source: SOURCE, lastRunAt: new Date(now).toISOString(), ok: true, count: enriched.length, error: null });

      if (!soldArchiveLocked(this.dataDir))
        await this.updateSoldArchive().catch(error => this.log("BRONVERA Rare: не добрал архив продаж Gooding:", error.message));

      if (this.alerts) {
        const newLots = enriched.filter(lot => !previousIds.has(lot.id));
        const allLotsById = new Map(enriched.map(lot => [lot.id, lot]));
        await this.alerts.checkAfterRun({ newLots, allLotsById }).catch(error => this.log("BRONVERA Rare: ошибка алертов (Gooding):", error.message));
      }

      return enriched;
    }
    catch (error) {
      this.writeStatus({ source: SOURCE, lastRunAt: new Date(now).toISOString(), ok: false, count: null, error: error.message });
      throw error;
    }
  }

  start(intervalMs = 24 * 3600 * 1000) {
    if (this.timer)
      return;
    const tick = () => this.run().catch(error => console.error("GoodingScraper error:", error.message));
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

GoodingScraper.parseGoodingLotPage = parseGoodingLotPage;
GoodingScraper.parseSitemap = parseSitemap;
GoodingScraper.cleanTitle = cleanTitle;

module.exports = GoodingScraper;
