const fs = require("fs");
const path = require("path");
const { guessMake, guessModel } = require("./title-parser");

/*
 * BRONVERA Rare, Фаза 3 (01.10.2026): третья площадка — RM Sotheby's.
 * Аукционный дом с живыми торгами по расписанию, не непрерывная лента,
 * как у BaT/PCARMARKET: лот в каталоге не имеет текущей ставки до самих
 * торгов, только диапазон оценки. На сайте это ничего не ломает —
 * currentBid остаётся null (карточка и так показывает «—» и «цена на
 * источнике пока не снята»), closesAt — дата самого аукциона (решение:
 * не заводить отдельный статус/поле, «До закрытия: 6 дней» читается
 * естественно и для выхода на торги тоже).
 *
 * Выдача — отдельный JSON API (не HTML, не требует браузера и прокси):
 * POST /api/search/SearchLots с фильтром CategoryTag:["Cars"] отсекает
 * часы/автомобилию/прочее сразу на сервере. Список аукционов берём с
 * /upcoming/ — коды меняются каждую распродажу, не хардкодим.
 *
 * Дата — со страницы самого аукциона (JSON-LD Event, startDate/endDate),
 * а не с каждого лота: текст «To be offered on…» есть не на всех лотах
 * (однодневные распродажи вроде Лондона его просто не печатают), а на
 * многодневных (Hershey) он точнее по дню, но расхождение в пределах
 * одной распродажи не критично — используем endDate события для всех
 * её лотов, один запрос на аукцион вместо одного на лот.
 */

const BASE_URL = "https://rmsothebys.com";
const UPCOMING_URL = `${BASE_URL}/upcoming/`;
const SEARCH_API = `${BASE_URL}/api/search/SearchLots`;
const PAGE_SIZE = 100;
const CLOSING_SOON_MS = 48 * 3600 * 1000;

// «$150,000 - $175,000 USD» — всегда первой строкой в мультивалютном блоке на странице лота, независимо от родной валюты лота.
const parseUsdEstimate = (html) => {
  const match = html.match(/\$([\d,]+)\s*-\s*\$([\d,]+)\s*USD/);
  if (!match)
    return { min: null, max: null };
  return { min: Number(match[1].replace(/,/g, "")), max: Number(match[2].replace(/,/g, "")) };
};

/*
 * Подпись «Chassis No.» и само значение — в разных элементах разметки,
 * не одной строкой текста:
 *   <div class="idlabel">Chassis No.</div>
 *   <div class="iddata">80492</div>
 * Для машин этого возраста это заводской номер шасси, не 17-значный
 * VIN — показываем как есть под тем же полем.
 */
const parseChassis = (html) => {
  const match = html.match(/(?:Chassis No\.|VIN)[\s\S]{0,200}?<div class="iddata"[^>]*>\s*([^<]+?)\s*<\/div>/i);
  return match ? match[1].trim() : null;
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

const toRareLot = (item, closesAt) => {
  const title = item.publicName;
  const make = guessMake(title);

  return {
    id: `rmsothebys-${item.id}`,
    title,
    make,
    model: guessModel(title, make),
    source: "RM Sotheby's",
    sourceUrl: item.link,
    mileage: null, // у довоенной/классической техники пробег почти никогда не заявлен отдельным полем
    transmission: null,
    vin: null, // подставляется из lot-details.json
    ownerType: null,
    estimateMin: null, // подставляется из lot-details.json — только оттуда оценка гарантированно в USD
    estimateMax: null,
    currentBid: null, // предпродажный каталог — живой ставки до торгов нет
    closesAt,
    status: statusOf(closesAt, Date.now()),
    photoUrl: item.crop || null,
  };
};

class RmSothebysScraper {
  constructor({
    fetchImpl = fetch,
    dataDir = path.join(process.cwd(), "data", "rare", "rmsothebys"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null,
  } = {}) {
    Object.assign(this, { fetchImpl, dataDir, now, log, alerts });
  }

  lotsFile() {
    return path.join(this.dataDir, "lots.json");
  }

  detailsFile() {
    return path.join(this.dataDir, "lot-details.json");
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
      return { source: "RM Sotheby's", lastRunAt: null, ok: null, count: null, error: null };
    }
  }

  readLots() {
    try {
      return JSON.parse(fs.readFileSync(this.lotsFile(), "utf8"));
    }
    catch {
      return { updatedAt: null, source: "RM Sotheby's", count: 0, lots: [] };
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

  // Коды распродаж («hf26», «lf26»…) меняются каждый сезон — берём со страницы расписания, не хардкодим.
  async fetchUpcomingAuctionCodes() {
    const response = await this.fetchImpl(UPCOMING_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" },
    });

    if (!response.ok)
      throw new Error(`RM Sotheby's (/upcoming/) ответил ${response.status}`);

    const html = await response.text();
    const codes = new Set([...html.matchAll(/\/auctions\/([a-z0-9]+)\/lots\//gi)].map(m => m[1].toLowerCase()));
    return [...codes];
  }

  // Дата аукциона — из разметки schema.org Event на его собственной странице, не с каждого лота.
  async fetchAuctionClosesAt(code) {
    const response = await this.fetchImpl(`${BASE_URL}/auctions/${code}/`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" },
    });

    if (!response.ok)
      throw new Error(`страница аукциона ${code} ответила ${response.status}`);

    const html = await response.text();
    const match = html.match(/"@type":"\s*Event"[\s\S]{0,500}?"endDate":"(\d{4}-\d{2}-\d{2})"/);
    if (!match)
      return null;
    // Только дата, без времени суток — считаем аукцион «не закрытым» до конца этого дня, не с полуночи.
    return new Date(`${match[1]}T23:59:59Z`).toISOString();
  }

  async fetchAuctionCarLots(code) {
    const items = [];
    let page = 0;

    while (true) {
      const response = await this.fetchImpl(`${SEARCH_API}?page=${page}&pageSize=${PAGE_SIZE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" },
        body: JSON.stringify({ LocationCountry: [], Collection: null, Auction: code.toUpperCase(), Day: null, SortBy: "Default", CategoryTag: ["Cars"], StillForSaleOnly: false }),
      });

      if (!response.ok)
        throw new Error(`SearchLots(${code}) ответил ${response.status}`);

      const data = await response.json();
      items.push(...(data.items || []));

      const totalPages = data.pager?.totalPages || 1;
      if (page + 1 >= totalPages)
        break;
      page += 1;
    }

    return items;
  }

  /*
   * Лоты и дату аукциона собираем кодом за кодом — один код может
   * оказаться закрытой sealed-распродажей без обычного каталога
   * (SearchLots тогда падает) или просто без лотов; это не должно
   * ронять весь прогон, и дата нужна каждому лоту сразу, пока мы его
   * ещё не оторвали от исходного кода аукциона.
   */
  async fetchActiveListings() {
    const codes = await this.fetchUpcomingAuctionCodes();
    const lots = [];

    for (const code of codes) {
      try {
        const items = await this.fetchAuctionCarLots(code);
        if (!items.length)
          continue;
        const closesAt = await this.fetchAuctionClosesAt(code);
        lots.push(...items.map(item => toRareLot(item, closesAt)));
      }
      catch (error) {
        this.log(`BRONVERA Rare: не собрал RM Sotheby's ${code}: ${error.message}`);
      }
    }

    return lots;
  }

  async fetchLotDetails(url) {
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" },
    });

    if (!response.ok)
      throw new Error(`страница лота ответила ${response.status}`);

    const html = await response.text();
    const { min, max } = parseUsdEstimate(html);
    return { vin: parseChassis(html), estimateMin: min, estimateMax: max };
  }

  async fetchMissingDetails(lots, cache, { delayMs = 350, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const missing = lots.filter(lot => !cache[lot.id]);
    let fetched = 0;

    for (const lot of missing) {
      try {
        cache[lot.id] = await this.fetchLotDetails(lot.sourceUrl);
      }
      catch (error) {
        this.log(`BRONVERA Rare: не разобрал страницу лота RM Sotheby's ${lot.id}: ${error.message}`);
        continue;
      }
      finally {
        fetched += 1;
      }
      await sleep(delayMs);
    }

    if (missing.length)
      this.log(`BRONVERA Rare: добрал детали по ${fetched} новым лотам RM Sotheby's (всего в кэше ${Object.keys(cache).length})`);

    return cache;
  }

  async run() {
    const now = this.now();
    const previousIds = new Set(this.readLots().lots.map(lot => lot.id));

    try {
      const lots = await this.fetchActiveListings();

      this.log(`BRONVERA Rare: собрано ${lots.length} лотов с RM Sotheby's`);

      const detailsCache = await this.fetchMissingDetails(lots, this.loadDetailsCache());
      this.saveDetailsCache(detailsCache);

      const enriched = lots.map(lot => ({ ...lot, ...(detailsCache[lot.id] || {}) }));

      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.lotsFile(),
        JSON.stringify({ updatedAt: new Date(now).toISOString(), source: "RM Sotheby's", count: enriched.length, lots: enriched }, null, 2),
      );

      this.writeStatus({ source: "RM Sotheby's", lastRunAt: new Date(now).toISOString(), ok: true, count: enriched.length, error: null });

      if (this.alerts) {
        const newLots = enriched.filter(lot => !previousIds.has(lot.id));
        const allLotsById = new Map(enriched.map(lot => [lot.id, lot]));
        await this.alerts.checkAfterRun({ newLots, allLotsById }).catch(error => this.log("BRONVERA Rare: ошибка алертов (RM Sotheby's):", error.message));
      }

      return enriched;
    }
    catch (error) {
      this.writeStatus({ source: "RM Sotheby's", lastRunAt: new Date(now).toISOString(), ok: false, count: null, error: error.message });
      throw error;
    }
  }

  start(intervalMs = 24 * 3600 * 1000) {
    if (this.timer)
      return;

    const tick = () => this.run().catch(error => console.error("RmSothebysScraper error:", error.message));

    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = RmSothebysScraper;
