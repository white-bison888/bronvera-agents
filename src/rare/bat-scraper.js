const fs = require("fs");
const path = require("path");
const { describeTransmission } = require("./transmission");
const { guessMake, guessModel } = require("./title-parser");

/*
 * BRONVERA Rare, Фаза 1 (план 30.09.2026): первая реальная площадка —
 * Bring a Trailer. Открыта без Cloudflare и без авторизации, и, в отличие
 * от bid.cars, отдаёт список активных лотов прямо в HTML главной страницы
 * аукционов одним JSON-блоком (var auctionsCurrentInitialData = {...}) —
 * ни браузер, ни прокси не нужны.
 *
 * Схема на будущее (алерты, много площадок) — в aggregator-approach.md:
 * лот разбирается один раз при попадании в индекс, не на каждый запрос
 * пользователя. Здесь — обновление раз в сутки перезаписывает один файл
 * текущего состояния, без истории по дням (она Rare пока не нужна).
 */

const LISTINGS_URL = "https://bringatrailer.com/auctions/";

/*
 * Категории BaT, которые точно не "редкая машина" в смысле этого сервиса:
 * мотоциклы, лодки, самолёты, поезда, тракторы, RV, запчасти, колёса,
 * мини-байки, квадроциклы, go-kart, side-by-side. Список id — из
 * BAT_MODEL_LISTINGS_TOOLBAR.categories на самой странице аукционов.
 * У большинства обычных машин категорий вообще нет — исключаем только то,
 * что явно попало в список.
 */
const EXCLUDE_CATEGORY_IDS = new Set([
  "543", // Aircraft
  "431", // All-Terrain Vehicles
  "383", // Boats
  "428", // Go-Karts
  "430", // Minibikes & Scooters
  "70", // Motorcycles
  "379", // Parts
  "436", // RVs & Campers
  "553", // Side-by-Sides
  "432", // Tractors
  "544", // Trains
  "380", // Wheels
]);

// Заголовки у BaT приходят как HTML: "4&#215;4" вместо "4×4", "&amp;" вместо "&".
const HTML_ENTITIES = { amp: "&", quot: "\"", "#039": "'", apos: "'", lt: "<", gt: ">", nbsp: " " };
const decodeHtmlEntities = (text) =>
  text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (full, code) => {
    if (code[0] === "#") {
      const codePoint = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isNaN(codePoint) ? full : String.fromCodePoint(codePoint);
    }
    return HTML_ENTITIES[code.toLowerCase()] ?? full;
  });

/*
 * «Five-Speed Manual Transmission», «Six-Speed Manual Transaxle»,
 * «Seven-Speed Dual-Clutch Automatic Transaxle» — у BaT в заголовке
 * пункта, не отдельными полями. describeTransmission превращает это в
 * короткое «5-ступенчатая механика».
 */

/*
 * Пробег, коробка передач, VIN и тип продавца — решение Mikita 30.09.2026
 * расширить «ключевую информацию» сверх заголовка, но не копировать всю
 * карточку BaT целиком. Этих полей нет в общей выдаче — только на
 * странице самого лота, и, в отличие от текущей ставки, они не меняются
 * по ходу торгов. Поэтому забираем их один раз на лот и кэшируем
 * навсегда в lot-details.json, а не перезапрашиваем каждый день вместе
 * со списком.
 */
const parseListingDetails = (html) => {
  const blockMatch = html.match(/<strong>Listing Details<\/strong><ul>(.*?)<\/ul>/s);
  const items = blockMatch
    ? [...blockMatch[1].matchAll(/<li>(.*?)<\/li>/gs)].map(m => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, "").trim()))
    : [];

  const vinItem = items.find(item => /^(Chassis|VIN):/i.test(item));
  const vin = vinItem ? vinItem.replace(/^(Chassis|VIN):\s*/i, "").trim() : null;

  // BaT иногда пишет сокращённо: «17k Miles» вместо «17,000 Miles».
  const mileageItem = items.find(item => /\bmiles?\b/i.test(item));
  const mileageMatch = mileageItem ? mileageItem.match(/([\d,]+)\s*(k)?\+?\s*Miles?/i) : null;
  const mileage = mileageMatch
    ? Math.round(Number(mileageMatch[1].replace(/,/g, "")) * (mileageMatch[2] ? 1000 : 1))
    : null;

  const transmissionRaw = items.find(item => /\b(manual|automatic)\b/i.test(item)) || null;

  const ownerMatch = html.match(/<strong>Private Party or Dealer<\/strong>:\s*([^<]+)</);
  const ownerTypeRaw = ownerMatch ? decodeHtmlEntities(ownerMatch[1].trim()) : null;
  const ownerType = ownerTypeRaw === "Private Party" ? "Частное лицо" : ownerTypeRaw === "Dealer" ? "Дилер" : ownerTypeRaw;

  return { vin, mileage, transmission: describeTransmission(transmissionRaw), ownerType, ...parseAuctionResult(html) };
};

/*
 * Баг от Mikita 01.10.2026: цена в индексе «/auctions/» обновляется у нас
 * раз в сутки, а решающие ставки часто идут в последние минуты торгов —
 * к моменту следующего прогона лот уже закрылся дороже, чем мы видели
 * (конкретный случай: у нас $1 026 000, у BaT «Sold for $1 261 000»).
 * После закрытия BaT публикует настоящий результат на странице лота —
 * «Sold for $X» (резерв достигнут) или «Bid to $X» (не достигнут, лот не
 * продан) — это и есть источник правды для завершённых лотов, индекс
 * больше не используется как финальная цена (см. run()).
 */
const parseAuctionResult = (html) => {
  const match = html.match(/info-value noborder-tiny">(Sold for|Bid to) <strong>USD \$([\d,]+)<\/strong>/);
  if (!match)
    return { finalPrice: null, sold: null };
  return { finalPrice: Number(match[2].replace(/,/g, "")), sold: match[1] === "Sold for" };
};

const CLOSING_SOON_MS = 48 * 3600 * 1000;

const statusOf = (item, now) => {
  const closesAt = item.timestamp_end * 1000;
  if (!item.active || closesAt <= now)
    return "ended";
  if (closesAt - now <= CLOSING_SOON_MS)
    return "closing";
  return "open";
};

const toRareLot = (item, now) => {
  const title = decodeHtmlEntities(item.title);
  const make = guessMake(title);

  return {
    id: `bat-${item.id}`,
    title,
    make,
    model: guessModel(title, make),
    source: "Bring a Trailer",
    sourceUrl: item.url,
    mileage: null, // подставляется из lot-details.json после первого разбора страницы лота
    transmission: null,
    vin: null,
    ownerType: null,
    estimateMin: null, // это не наш прогноз, а честная цена BaT — оценки у нас для этих лотов нет
    estimateMax: null,
    currentBid: typeof item.current_bid === "number" ? item.current_bid : null,
    closesAt: item.timestamp_end ? new Date(item.timestamp_end * 1000).toISOString() : null,
    status: statusOf(item, now),
    photoUrl: item.thumbnail_url || null,
  };
};

class BatScraper {
  constructor({
    fetchImpl = fetch,
    dataDir = path.join(process.cwd(), "data", "rare"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null, // RareAlerts — необязателен, чтобы тесты и ручные прогоны не требовали Telegram
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

  /*
   * Статус для вкладки Status на сайте (01.10.2026): когда источник в
   * последний раз прошли, сколько лотов собрали, и текст ошибки, если
   * не прошли. До первого прогона — ok: null, а не false, чтобы не
   * путать «ещё не проверяли» с «сломано».
   */
  readStatus() {
    try {
      return JSON.parse(fs.readFileSync(this.statusFile(), "utf8"));
    }
    catch {
      return { source: "Bring a Trailer", lastRunAt: null, ok: null, count: null, error: null };
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

  async fetchLotDetails(url) {
    const response = await this.fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" },
    });

    if (!response.ok)
      throw new Error(`страница лота ответила ${response.status}`);

    return parseListingDetails(await response.text());
  }

  /*
   * Новые лоты за прогон — последовательно, с паузой: вежливо к BaT и не
   * похоже на массовый обход. Если лотов много (первый прогон — тысяча с
   * лишним), это не проблема: сборщик фоновый, не держит HTTP-ответ сайта.
   */
  async fetchMissingDetails(lots, cache, { delayMs = 350, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    // Лот закрылся после того, как мы однажды разобрали его страницу (а то и
    // вообще впервые увиден уже закрытым) — в обоих случаях настоящей цены
    // закрытия в кэше ещё нет, добираем её отдельным проходом.
    const needsResult = lot => lot.status === "ended" && cache[lot.id]?.finalPrice === undefined;
    const missing = lots.filter(lot => !cache[lot.id] || needsResult(lot));
    let fetched = 0;

    for (const lot of missing) {
      try {
        const details = await this.fetchLotDetails(lot.sourceUrl);
        // Слияние, не замена: повторный разбор — только за finalPrice у уже
        // закрытых лотов, и если на этот раз какое-то поле не нашлось
        // (например, другая вёрстка страницы после закрытия торгов), уже
        // известные пробег/VIN/коробка не должны стираться пустым значением.
        const facts = Object.fromEntries(
          Object.entries(details).filter(([key, value]) => key !== "finalPrice" && key !== "sold" && value !== null),
        );
        // finalPrice/sold фиксируем только для уже закрытых лотов — null
        // здесь означает «проверили, результата на странице нет», и это
        // наверняка значит «ещё не ended» для открытого лота, не отсутствие
        // результата. Фиксировать его раньше времени — не перепроверим
        // позже, когда торги правда закроются (см. needsResult выше).
        const result = lot.status === "ended" ? { finalPrice: details.finalPrice, sold: details.sold } : {};
        cache[lot.id] = { ...cache[lot.id], ...facts, ...result };
      }
      catch (error) {
        this.log(`BRONVERA Rare: не разобрал страницу лота ${lot.id}: ${error.message}`);
        continue;
      }
      finally {
        fetched += 1;
        if (fetched % 100 === 0)
          this.log(`BRONVERA Rare: разобрано ${fetched}/${missing.length} новых страниц лотов`);
      }
      await sleep(delayMs);
    }

    if (missing.length)
      this.log(`BRONVERA Rare: добрал детали по ${fetched} новым лотам (всего в кэше ${Object.keys(cache).length})`);

    return cache;
  }

  /*
   * Страница отдаёт данные внутри <script id="bat-theme-auctions-current-
   * initial-data">var auctionsCurrentInitialData = {...};. Регулярка
   * ищет ровно эту переменную, а не любой JSON на странице.
   */
  async fetchActiveListings() {
    const response = await this.fetchImpl(LISTINGS_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" },
    });

    if (!response.ok)
      throw new Error(`Bring a Trailer ответил ${response.status}`);

    const html = await response.text();
    const match = html.match(/var auctionsCurrentInitialData = (\{.*?\});\s*\/\* \]\]> \*\//s);

    if (!match)
      throw new Error("Не нашёл auctionsCurrentInitialData на странице — вёрстка BaT могла измениться");

    const data = JSON.parse(match[1]);
    return Array.isArray(data.items) ? data.items : [];
  }

  async run() {
    const now = this.now();
    // До перезаписи — чтобы потом отличить реально новые лоты от уже виденных (для алертов).
    const previousIds = new Set(this.readLots().lots.map(lot => lot.id));

    try {
      const items = await this.fetchActiveListings();
      const lots = items
        .filter(item => !(item.categories || []).some(id => EXCLUDE_CATEGORY_IDS.has(String(id))))
        .map(item => toRareLot(item, now));

      this.log(`BRONVERA Rare: собрано ${lots.length} лотов с Bring a Trailer (из ${items.length} активных объявлений всех категорий)`);

      const detailsCache = await this.fetchMissingDetails(lots, this.loadDetailsCache());
      this.saveDetailsCache(detailsCache);

      const enriched = lots.map((lot) => {
        const details = detailsCache[lot.id] || {};
        // Для завершённых лотов настоящая цена закрытия (finalPrice) важнее
        // устаревшего снимка ставки из индекса — см. parseAuctionResult.
        const currentBid = (lot.status === "ended" && typeof details.finalPrice === "number") ? details.finalPrice : lot.currentBid;
        return { ...lot, ...details, currentBid };
      });

      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.lotsFile(),
        JSON.stringify({ updatedAt: new Date(now).toISOString(), source: "Bring a Trailer", count: enriched.length, lots: enriched }, null, 2),
      );

      this.writeStatus({ source: "Bring a Trailer", lastRunAt: new Date(now).toISOString(), ok: true, count: enriched.length, error: null });

      if (this.alerts) {
        const newLots = enriched.filter(lot => !previousIds.has(lot.id));
        const allLotsById = new Map(enriched.map(lot => [lot.id, lot]));
        // Сбой отправки алерта не должен валить весь суточный прогон.
        await this.alerts.checkAfterRun({ newLots, allLotsById }).catch(error => this.log("BRONVERA Rare: ошибка алертов:", error.message));
      }

      return enriched;
    }
    catch (error) {
      this.writeStatus({ source: "Bring a Trailer", lastRunAt: new Date(now).toISOString(), ok: false, count: null, error: error.message });
      throw error;
    }
  }

  readLots() {
    try {
      return JSON.parse(fs.readFileSync(this.lotsFile(), "utf8"));
    }
    catch {
      return { updatedAt: null, source: "Bring a Trailer", count: 0, lots: [] };
    }
  }

  /* Раз в сутки: первый прогон сразу при старте, дальше каждые 24 часа. */
  start(intervalMs = 24 * 3600 * 1000) {
    if (this.timer)
      return;

    const tick = () => this.run().catch(error => console.error("BatScraper error:", error.message));

    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = BatScraper;
