const fs = require("fs");
const path = require("path");
const { describeTransmission } = require("./transmission");
const { guessMake, guessModel } = require("./title-parser");
const { loadSoldArchive, readSoldArchiveCached, saveSoldArchive, soldArchiveLocked, yearFromTitle } = require("./sold-archive");
const { FxRates } = require("./fx");
const { classifyVin, colorGroupOf, decodeEntities: decodeBatEntities, parseBatExcerpt, transmissionKind } = require("./sold-fields");
const { fillAttributes, parseVehicleAttributes } = require("./sold-attrs");
const { enrichFromPages } = require("./sold-pages");

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
const parseListingItems = (html) => {
  const blockMatch = html.match(/<strong>Listing Details<\/strong><ul>(.*?)<\/ul>/s);
  return blockMatch
    ? [...blockMatch[1].matchAll(/<li>(.*?)<\/li>/gs)].map(m => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, "").trim()))
    : [];
};

const parseListingDetails = (html) => {
  const items = parseListingItems(html);

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
 * Страница завершённого лота: в «Listing Details» перечислено, что в машине
 * («4,900 Miles», «Twin-Turbocharged 3.7-Liter Flat-Six», «Eight-Speed PDK…»,
 * «All-Wheel-Drive System», «Chalk Paint», «Cognac … Leather», пакеты и
 * опции). Из неё берём пробег, цвет кузова и салона, двигатель, привод и
 * комплектацию — это точнее и полнее описания из списка.
 */
const parseSoldPage = (html, lot = {}) => {
  const items = parseListingItems(html);
  if (!items.length)
    return {};

  const mileageItem = items.find(item => /\b(miles?|kilometers?|km)\b/i.test(item) && /\d/.test(item));
  const paintItem = items.find(item => /\bpaint\b|\bfinish\b|\bpaintwork\b/i.test(item) && !/\b(wheels?|trim|accents|stripes?)\b/i.test(item));
  const exteriorColor = paintItem ? paintItem.replace(/\s*(?:metallic\s+)?(?:paint(?:work)?|finish)\s*$/i, "").replace(/\b(Two-Tone|Single-Stage|Factory|Repainted|Original)\s*/gi, "").trim() || null : null;
  const interiorItem = items.find(item => /\b(leather|cloth|vinyl|upholstery|alcantara|interior|velour|suede|corduroy)\b/i.test(item));
  const transmissionItem = items.find(item => /\b(manual|automatic|dual-clutch|pdk|dsg|cvt)\b/i.test(item));
  const engineItem = items.find(item => /\b(liter|litre|cc|ci|flat-|inline-|straight-|v-?(6|8|10|12|16)|rotary|turbo|supercharged)\b/i.test(item) && !/\b(wheels?|exhaust|headlights|brakes)\b/i.test(item));

  const known = new Set([mileageItem, paintItem, interiorItem, transmissionItem, engineItem].filter(Boolean));
  const facts = items
    .filter(item => !known.has(item) && !/^(Chassis|VIN)\b/i.test(item) && item.length <= 90)
    .slice(0, 12);

  const miles = mileageItem ? mileageItem.match(/([\d,]+(?:\.\d+)?)\s*(k)?\+?\s*(miles?|km|kilometers?)/i) : null;
  let mileage = null;
  if (miles) {
    const base = Number(miles[1].replace(/,/g, "")) * (miles[2] ? 1000 : 1);
    mileage = Math.round(/^k/i.test(miles[3]) ? base / 1.609344 : base);
  }

  const attrs = parseVehicleAttributes(lot.title, items.join(". "));
  const vinItem = items.find(item => /^(Chassis|VIN):/i.test(item));

  return {
    ...(vinItem ? classifyVin(vinItem.replace(/^(Chassis|VIN):\s*/i, "")) : {}),
    mileage,
    transmission: describeTransmission(transmissionItem),
    transmissionKind: transmissionKind(transmissionItem),
    exteriorColor,
    colorGroup: colorGroupOf(exteriorColor),
    interiorColor: interiorItem ? interiorItem.slice(0, 80) : null,
    conditionFacts: facts,
    ...attrs,
  };
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

/*
 * Вкладка Stats (02.10.2026, просьба Mikita): архив проданных лотов,
 * отдельно от lots.json — активный список перезаписывается целиком на
 * каждом прогоне и теряет лот, как только он выпадает из «/auctions/»
 * BaT (проверено: закрытый лот пропадает из индекса в течение суток).
 * sold: null (ещё не знаем исход — см. needsResult в fetchMissingDetails)
 * сюда не идёт: архивируем только то, что действительно разрешилось.
 */
/*
 * Итоги торгов за всю историю (02.10.2026, просьба Mikita): у BaT есть
 * открытый список завершённых аукционов — тот же, что страница
 * /auctions/results/, JSON по адресу wp-json/.../listings-filter. Он отдаёт
 * по 60 лотов на страницу вместе с ценой («Sold for USD $26,500» — продан,
 * «Bid to …» — резерв не достигнут), датой закрытия, фото и коротким
 * описанием, из которого берём цвет, пробег и коробку (для лотов «из
 * индекса /auctions/» этого нет, а страницу каждого лота разбирать —
 * десятки тысяч запросов).
 *
 * Ограничения самого BaT: глубже ~165 страниц (≈10 000 лотов) выборка пустая,
 * поэтому история режется по «эпохам» выпуска (параметр eras) — по 10 000
 * самых свежих лотов каждой эпохи. А на частые запросы он отвечает «Slow
 * down your API calls» — идём с паузой и ждём, если просят притормозить.
 */
const COMPLETED_URL = "https://bringatrailer.com/wp-json/bringatrailer/1.0/data/listings-filter";
const ERAS = ["2020", "2010", "2000", "1990", "1980", "1970", "1960", "1950", "1940", "1930", "1920", "1910", "1900", "pre-1900"];
const COMPLETED_PER_PAGE = 60;
const COMPLETED_MAX_PAGE = 165;
const REQUEST_GAP_MS = 1500;
// Поля, которые можно дописать лоту, уже лежащему в архиве, не затирая известное.
const ENRICH_KEYS = ["mileage", "transmission", "transmissionKind", "exteriorColor", "colorGroup", "bodyStyle", "cylinders", "engineLayout", "displacement", "aspiration", "drivetrain", "steering", "flags"];
const SLOW_DOWN_WAIT_MS = 30_000;

// Мотоциклы, скутеры и прочее не-авто попадают в тот же список без категорий — отсекаем по названию.
const NOT_A_CAR = /\b(motorcycle|scooter|moped|sidecar|snowmobile|tractor|Harley-Davidson|Ducati|Vespa|Yamaha|Kawasaki|Aprilia|Moto Guzzi|Piaggio|Lambretta)\b/i;

const parseCompletedResult = (item) => {
  const match = String(item.sold_text || "").match(/^(Sold for|Bid to)\s+(?:([A-Z]{3})\s+)?[^\d]*([\d,]+)/);
  if (!match)
    return null; // «Withdrawn by BaT» и т. п. — результата торгов нет
  const price = typeof item.current_bid === "number" ? item.current_bid : Number(match[3].replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0 || !item.sold_text_timestamp)
    return null;
  return { sold: match[1] === "Sold for", price, currency: String(item.currency || match[2] || "USD").toUpperCase() };
};

const toCompletedSoldLot = (item) => {
  const result = parseCompletedResult(item);
  if (!result)
    return null;

  const title = decodeBatEntities(item.title);
  if (NOT_A_CAR.test(title))
    return null;

  const make = guessMake(title);
  const details = parseBatExcerpt(title, item.excerpt);

  return {
    id: `bat-${item.id}`,
    title,
    make,
    model: guessModel(title, make),
    year: yearFromTitle(title),
    source: "Bring a Trailer",
    sourceUrl: item.url,
    soldAt: new Date(item.sold_text_timestamp * 1000).toISOString(),
    salePrice: result.currency === "USD" ? result.price : null, // для других валют — по курсу на день продажи, см. updateSoldFromCompleted
    ...(result.currency === "USD" ? {} : { salePriceLocal: result.price, currency: result.currency }),
    sold: result.sold,
    mileage: details.mileage,
    transmission: describeTransmission(details.transmissionRaw),
    transmissionKind: transmissionKind(details.transmissionRaw),
    exteriorColor: details.exteriorColor,
    colorGroup: colorGroupOf(details.exteriorColor),
    ...parseVehicleAttributes(title, decodeBatEntities(item.excerpt)),
    photoUrl: item.thumbnail_url || null,
  };
};

const toSoldLot = enrichedLot => ({
  id: enrichedLot.id,
  title: enrichedLot.title,
  make: enrichedLot.make,
  model: enrichedLot.model,
  year: yearFromTitle(enrichedLot.title),
  source: enrichedLot.source,
  sourceUrl: enrichedLot.sourceUrl,
  soldAt: enrichedLot.closesAt,
  salePrice: enrichedLot.currentBid,
  sold: enrichedLot.sold,
  estimateMin: enrichedLot.estimateMin,
  estimateMax: enrichedLot.estimateMax,
  mileage: enrichedLot.mileage,
  transmission: enrichedLot.transmission,
  conditionFacts: [],
  photoUrl: enrichedLot.photoUrl,
});

class BatScraper {
  constructor({
    fetchImpl = fetch,
    dataDir = path.join(process.cwd(), "data", "rare"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null, // RareAlerts — необязателен, чтобы тесты и ручные прогоны не требовали Telegram
    fx = new FxRates({ file: path.join(dataDir, "fx-rates.json") }),
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

  readSold() {
    return Object.values(readSoldArchiveCached(this.soldFile()));
  }

  /* Архив копится: каждый разрешённый (sold: true/false, не null) лот добавляется один раз. */
  updateSoldArchive(enriched) {
    const archive = loadSoldArchive(this.soldFile());
    let added = 0;

    for (const lot of enriched) {
      if (lot.status !== "ended" || lot.sold === null || lot.sold === undefined || typeof lot.currentBid !== "number")
        continue;
      if (!archive[lot.id]) {
        archive[lot.id] = toSoldLot(lot);
        added += 1;
      }
    }

    if (added) {
      saveSoldArchive(this.soldFile(), archive);
      this.log(`BRONVERA Rare: добавил ${added} проданных лотов BaT в архив (всего ${Object.keys(archive).length})`);
    }

    return added;
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
    // закрытия в кэше ещё нет, добираем её отдельным проходом. Проверяем
    // typeof === "number", а не просто "есть ключ": BaT продлевает торги
    // при ставках в последние секунды, наш timestamp_end из вчерашнего
    // индекса может посчитать лот закрытым раньше настоящего закрытия —
    // тогда результата на странице ещё нет, и null нельзя запоминать
    // навсегда, иначе зависнет так же, как и баг, который чиним.
    const needsResult = lot => lot.status === "ended" && typeof cache[lot.id]?.finalPrice !== "number";
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

  async fetchCompletedPage(era, page) {
    const url = `${COMPLETED_URL}?page=${page}&per_page=${COMPLETED_PER_PAGE}&get_items=1&get_stats=0&sort=td&eras=${encodeURIComponent(era)}`;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" } });
      const body = await response.json().catch(() => null);

      if (response.ok && body && Array.isArray(body.items))
        return body.items;

      if (/slow down/i.test(String(body?.message || "")) && attempt < 3) {
        await this.sleep(SLOW_DOWN_WAIT_MS * (attempt + 1));
        continue;
      }

      throw new Error(`BaT (завершённые, ${era}, страница ${page}) ответил ${response.status}${body?.message ? `: ${body.message}` : ""}`);
    }

    return [];
  }

  /*
   * Ежедневный заход берёт 3–4 первые страницы каждой эпохи (новые итоги
   * лежат сверху) и останавливается, когда страница целиком знакома.
   * Для разового добора истории: maxPages = 165, stopWhenKnown = false.
   * Лоты в другой валюте считаются по курсу ЕЦБ на день продажи (fx.js);
   * если курса нет — лот пропускаем, попробуем в следующий раз.
   */
  async updateSoldFromCompleted({ eras = ERAS, maxPages = 4, stopWhenKnown = true, sinceMs = null } = {}) {
    const archive = loadSoldArchive(this.soldFile());
    let added = 0;
    let requests = 0;

    for (const era of eras) {
      let eraAdded = 0;
      let eraEnriched = 0;

      for (let page = 1; page <= Math.min(maxPages, COMPLETED_MAX_PAGE); page += 1) {
        if (requests > 0)
          await this.sleep(REQUEST_GAP_MS);
        requests += 1;

        const items = await this.fetchCompletedPage(era, page);
        let newOnPage = 0;
        let reachedCutoff = false;

        for (const item of items) {
          const lot = toCompletedSoldLot(item);
          if (!lot)
            continue;
          if (sinceMs !== null && Date.parse(lot.soldAt) < sinceMs) {
            reachedCutoff = true;
            continue;
          }
          if (archive[lot.id]) {
            // Лот уже был в архиве без цвета/пробега (из индекса /auctions/) — дополняем, не затираем.
            const known = archive[lot.id];
            for (const key of ENRICH_KEYS) {
              if ((known[key] === null || known[key] === undefined) && lot[key] !== null && lot[key] !== undefined) {
                known[key] = lot[key];
                eraEnriched += 1;
              }
            }
            continue;
          }
          if (lot.salePrice === null) {
            try {
              Object.assign(lot, await this.fx.convert(lot.salePriceLocal, lot.currency, lot.soldAt));
            }
            catch (error) {
              this.log(`BRONVERA Rare: BaT ${lot.id}: курс на день продажи не получен (${error.message})`);
              continue;
            }
          }
          archive[lot.id] = lot;
          newOnPage += 1;
        }

        added += newOnPage;
        eraAdded += newOnPage;

        if (items.length < COMPLETED_PER_PAGE || reachedCutoff || (stopWhenKnown && newOnPage === 0))
          break;
      }

      if (eraAdded > 0 || eraEnriched > 0)
        saveSoldArchive(this.soldFile(), archive); // контрольная точка: при сбое на следующей эпохе уже добытое не теряется
      this.log(`BRONVERA Rare: BaT, эпоха ${era}: добавил ${eraAdded} (всего в архиве ${Object.keys(archive).length})`);
    }

    return added;
  }

  /*
   * Дописывает проданным лотам из архива пробег, цвет, комплектацию со страницы
   * лота (см. parseSoldPage). minPrice — чтобы начать с дорогих машин, ради
   * которых сервис и существует; limit — сколько страниц за заход.
   */
  async enrichSoldFromPages({ minPrice = 0, limit = Infinity, delayMs = 600, soldOnly = true, concurrency = 1 } = {}) {
    const archive = loadSoldArchive(this.soldFile());
    const lots = Object.values(archive)
      .filter(lot => lot.sourceUrl && lot.salePrice >= minPrice && (!soldOnly || lot.sold !== false))
      .sort((a, b) => b.salePrice - a.salePrice);

    return enrichFromPages({
      lots,
      limit,
      delayMs,
      concurrency,
      sleep: this.sleep,
      now: this.now,
      log: this.log,
      label: "Bring a Trailer",
      save: () => saveSoldArchive(this.soldFile(), archive),
      fetchHtml: async (lot) => {
        const response = await this.fetchImpl(lot.sourceUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)" } });
        if (response.status === 404)
          return null;
        if (!response.ok)
          throw new Error(`страница ответила ${response.status}`);
        return response.text();
      },
      parse: (html, lot) => parseSoldPage(html, lot),
    });
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

      if (soldArchiveLocked(this.dataDir)) {
        this.log("BRONVERA Rare: архив продаж BaT занят разовым добором данных — суточное обновление пропускаю");
      }
      else {
        this.updateSoldArchive(enriched);
        await this.updateSoldFromCompleted().catch(error => this.log("BRONVERA Rare: не добрал итоги BaT из списка завершённых:", error.message));
      }

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

BatScraper.parseSoldPage = parseSoldPage;
BatScraper.toCompletedSoldLot = toCompletedSoldLot;

module.exports = BatScraper;
