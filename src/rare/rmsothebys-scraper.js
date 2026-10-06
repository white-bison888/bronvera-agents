const fs = require("fs");
const path = require("path");
const { guessMake, guessModel } = require("./title-parser");
const { runFinishInChild } = require("./finish-new-sold");
const { loadSoldArchive, readSoldArchiveCached, saveSoldArchive, soldArchiveLocked, yearFromTitle } = require("./sold-archive");
const { FxRates, reconvertArchive } = require("./fx");
const { bodyStyleOf, parseVehicleAttributes } = require("./sold-attrs");
const { enrichFromPages } = require("./sold-pages");
const { classifyVin, colorGroupOf, decodeEntities, parseRmText, transmissionKind } = require("./sold-fields");
const { describeTransmission } = require("./transmission");

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
const RESULTS_URL = `${BASE_URL}/results/`; // свежие итоги этого сезона
const PAST_AUCTIONS_URL = `${BASE_URL}/past-auctions/`; // весь архив торгов
const SETTLE_MS = 3 * 24 * 3600 * 1000; // через столько после конца аукциона итоги считаем окончательными и больше не перепроверяем
const MAX_AUCTIONS_PER_RUN = 40; // за один заход берём не больше аукционов — архив добирается постепенно, а не одним залпом запросов

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

/*
 * Вкладка Stats (02.10.2026): итоги прошедших торгов. Тот же SearchLots, что
 * для будущих аукционов, но у завершённых лотов в value стоит цена продажи
 * («$56,000 USD», «£15,525 GBP», «€92,000 EUR», «CHF71,300»), а valueType —
 * «Sold». У «Not Sold» в value диапазон оценки, не ставка — цены сделки нет,
 * не архивируем; у закрытых (Sealed) торгов цена не публикуется вовсе. Цена RM
 * включает комиссию покупателя — у части других площадок (например, Bring a
 * Trailer) «Sold for» это цена молотка без неё, прямо сравнивать осторожно.
 * В архиве храним исходную цену и валюту (salePriceLocal + currency), а
 * salePrice в USD считаем по курсу ЕЦБ на день продажи (см. fx.js).
 */
const CURRENCY_BY_SYMBOL = { "$": "USD", "£": "GBP", "€": "EUR", "CHF": "CHF" };

const parseSoldValue = (value) => {
  const text = String(value || "").trim();
  if (text.includes(" - "))
    return null; // диапазон оценки, не цена продажи
  const match = text.match(/^(\$|£|€|CHF)\s?([\d,]+)/);
  if (!match)
    return null;
  const currency = CURRENCY_BY_SYMBOL[match[1]];
  const amount = Number(match[2].replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0 ? { amount, currency } : null;
};

const toSoldLot = (item, endDate, code) => {
  if (item.valueType !== "Sold" || !item.sold || !endDate)
    return null;

  const price = parseSoldValue(item.value);
  const year = yearFromTitle(item.publicName); // без года — не автомобиль (афиши, сувениры в категории Cars)
  if (!price || !year)
    return null;

  const title = item.publicName;
  const make = guessMake(title);

  return {
    id: `rmsothebys-${item.id}`,
    title,
    make,
    model: guessModel(title, make),
    year,
    source: "RM Sotheby's",
    sourceUrl: item.link,
    soldAt: `${endDate}T00:00:00.000Z`, // у каждого лота своей даты нет — день окончания аукциона
    salePrice: null, // подставляется по курсу на день продажи
    salePriceLocal: price.amount,
    currency: price.currency,
    auctionCode: code,
    sold: true,
    estimateMin: null,
    estimateMax: null,
    mileage: null,
    transmission: null,
    conditionFacts: [],
    ...parseVehicleAttributes(title),
    photoUrl: item.crop || null,
  };
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

/*
 * Страница лота RM — основной текст (пункты «highlights» и очерк). Из него
 * берём цвет, пробег, коробку, двигатель, привод и кузов. Структурированных
 * полей у RM нет, поэтому полнота зависит от того, что написал автор очерка.
 */
const textOfPage = (html) => {
  // Только сам лот: пункты «highlights» и очерк. Всё остальное на странице (меню, «You may also like»,
  // соседние лоты) — чужие машины, из них в разбор лезли чужие кузова и цвета.
  const bullets = (html.match(/<ul class="list-bullets[^"]*"[^>]*>([\s\S]*?)<\/ul>/) || [])[1] || "";
  const essayStart = html.search(/class="container container--vw lotdescription"/);
  let essay = "";
  if (essayStart >= 0) {
    const rest = html.slice(essayStart);
    const end = rest.search(/You may also like/i);
    essay = end > 0 ? rest.slice(0, end) : rest.slice(0, 40000);
  }
  const plain = fragment => decodeEntities(fragment.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, "\n")).split("\n").map(line => line.trim()).filter(Boolean).join(" ");
  return `${plain(bullets)} ${plain(essay)}`.trim();
};

const parseRmLotPage = (html, lot = {}) => {
  const text = textOfPage(html);
  const chassis = classifyVin(parseChassis(html));
  if (!text)
    return chassis;
  const found = parseRmText(text);
  const attrs = parseVehicleAttributes(lot.title, text);
  const bodyStyle = bodyStyleOf(lot.title); // кузов — только по названию лота: в очерке упоминаются и другие модели
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

class RmSothebysScraper {
  constructor({
    fetchImpl = fetch,
    dataDir = path.join(process.cwd(), "data", "rare", "rmsothebys"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null,
    fx = new FxRates({ file: path.join(dataDir, "..", "fx-rates.json") }),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    Object.assign(this, { fetchImpl, dataDir, now, log, alerts, fx, sleep });
  }

  lotsFile() {
    return path.join(this.dataDir, "lots.json");
  }

  detailsFile() {
    return path.join(this.dataDir, "lot-details.json");
  }

  soldFile() {
    return path.join(this.dataDir, "sold.json");
  }

  soldAuctionsFile() {
    return path.join(this.dataDir, "sold-auctions.json");
  }

  readSold() {
    return Object.values(readSoldArchiveCached(this.soldFile()));
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
      throw Object.assign(new Error(`страница аукциона ${code} ответила ${response.status}`), { status: response.status });

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

  async fetchCodesFrom(url) {
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" },
    });

    if (!response.ok)
      throw new Error(`RM Sotheby's (${url}) ответил ${response.status}`);

    const html = await response.text();
    return [...new Set([...html.matchAll(/\/auctions\/([a-z0-9]+)\/lots\//gi)].map(m => m[1].toLowerCase()))];
  }

  loadSoldAuctions() {
    try {
      return JSON.parse(fs.readFileSync(this.soldAuctionsFile(), "utf8"));
    }
    catch {
      return {};
    }
  }

  /*
   * Аукцион «закрыт для проверки», когда его итоги уже окончательные:
   * прошло SETTLE_MS после последнего дня, а проверяли мы его уже после
   * этого. Свежие аукционы перепроверяем каждый заход — часть лотов
   * подводит итог не в тот же день. Если даты у аукциона нет, лотам
   * нечего подставить в soldAt — проверили раз и больше не трогаем.
   */
  isSettled(entry, now) {
    if (!entry)
      return false;
    if (!entry.endDate)
      return true;
    const settledAt = Date.parse(`${entry.endDate}T23:59:59Z`) + SETTLE_MS;
    return now > settledAt && Date.parse(entry.checkedAt) > settledAt;
  }

  async updateSoldArchive({ maxAuctions = MAX_AUCTIONS_PER_RUN } = {}) {
    const now = this.now();
    const archive = loadSoldArchive(this.soldFile());
    const auctions = this.loadSoldAuctions();

    // Свежие итоги — первыми, потом весь архив торгов (его страница тяжёлая и может отвалиться — не страшно).
    const codes = await this.fetchCodesFrom(RESULTS_URL);
    try {
      for (const code of await this.fetchCodesFrom(PAST_AUCTIONS_URL)) {
        if (!codes.includes(code))
          codes.push(code);
      }
    }
    catch (error) {
      this.log("BRONVERA Rare: не прочитал список прошедших аукционов RM Sotheby's:", error.message);
    }

    const pending = codes.filter(code => !this.isSettled(auctions[code], now)).slice(0, maxAuctions);
    let added = 0;

    for (const code of pending) {
      try {
        const items = await this.fetchAuctionCarLots(code);
        const closesAt = await this.fetchAuctionClosesAt(code); // и у аукциона без машин — иначе пустой ответ «закрыл» бы свежие торги навсегда
        const endDate = closesAt ? closesAt.slice(0, 10) : null;

        let skippedForFx = 0;

        for (const item of items) {
          const soldLot = toSoldLot(item, endDate, code);
          if (!soldLot || archive[soldLot.id])
            continue;
          try {
            Object.assign(soldLot, await this.fx.convert(soldLot.salePriceLocal, soldLot.currency, soldLot.soldAt));
          }
          catch (error) {
            skippedForFx += 1;
            if (skippedForFx === 1)
              this.log(`BRONVERA Rare: не пересчитал цены RM Sotheby's ${code} по курсу на дату продажи: ${error.message}`);
            continue;
          }
          archive[soldLot.id] = soldLot;
          added += 1;
        }

        // Курса не было — аукцион не «закрываем», чтобы вернуться к нему в следующий заход.
        if (skippedForFx > 0)
          continue;

        auctions[code] = { endDate, checkedAt: new Date(now).toISOString() };
      }
      catch (error) {
        this.log(`BRONVERA Rare: не собрал итоги RM Sotheby's ${code}: ${error.message}`);
        // Страницы аукциона нет вовсе (старые торги) — даты лотам взять неоткуда, больше не пробуем.
        if (error.status === 404)
          auctions[code] = { endDate: null, checkedAt: new Date(now).toISOString() };
      }
    }

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.soldAuctionsFile(), JSON.stringify(auctions, null, 2));

    const reconverted = await reconvertArchive(archive, this.fx, this.log);

    if (added > 0 || reconverted > 0) {
      saveSoldArchive(this.soldFile(), archive);
      this.log(`BRONVERA Rare: добавил ${added} проданных лотов RM Sotheby's в архив (всего ${Object.keys(archive).length})`);
    }

    return added;
  }

  /* Дописывает проданным лотам из архива пробег, цвет, коробку и двигатель со страницы лота. */
  async enrichSoldFromPages({ limit = Infinity, delayMs = 350, concurrency = 1 } = {}) {
    const archive = loadSoldArchive(this.soldFile());
    const lots = Object.values(archive)
      .filter(lot => lot.sourceUrl)
      .sort((a, b) => b.salePrice - a.salePrice);

    return enrichFromPages({
      lots,
      limit,
      delayMs,
      concurrency,
      sleep: this.sleep,
      now: this.now,
      log: this.log,
      label: "RM Sotheby's",
      save: () => saveSoldArchive(this.soldFile(), archive),
      fetchHtml: async (lot) => {
        const response = await this.fetchImpl(lot.sourceUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" } });
        if (response.status === 404)
          return null;
        if (!response.ok)
          throw new Error(`страница ответила ${response.status}`);
        return response.text();
      },
      parse: (html, lot) => parseRmLotPage(html, lot),
    });
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

      if (!soldArchiveLocked(this.dataDir))
        await this.updateSoldArchive().catch(error => this.log("BRONVERA Rare: не добрал архив продаж RM Sotheby's:", error.message));
      if (this.finishSoldKey && !soldArchiveLocked(this.dataDir))
        await runFinishInChild(this.finishSoldKey, this.log);

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

RmSothebysScraper.parseRmLotPage = parseRmLotPage;

module.exports = RmSothebysScraper;
