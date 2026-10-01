const fs = require("fs");
const path = require("path");

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

// Многословные марки — иначе наивный разбор возьмёт только первое слово.
const MULTI_WORD_MAKES = [
  "Alfa Romeo", "Aston Martin", "Land Rover", "Mercedes-Benz", "Rolls-Royce",
  "De Tomaso", "Am General",
];

/*
 * Год не всегда первое слово — бывает «Modified 1996 Porsche…», «9k-Mile
 * 2008 Porsche…». Берём то, что идёт сразу после первого четырёхзначного
 * года 19xx/20xx, а не первое слово заголовка.
 */
const guessMake = (title) => {
  const match = title.match(/\b(19|20)\d{2}\b\s+(.+)$/);
  const rest = match ? match[2] : title;
  const multiWord = MULTI_WORD_MAKES.find(make => rest.startsWith(make));
  if (multiWord)
    return multiWord;
  return rest.split(/\s+/)[0] || "";
};

/*
 * Модель — слова после марки до первого слова, которое явно про кузов или
 * трансмиссию, а не про саму модель («Modified 1985 BMW 325e Coupe
 * 5-Speed» → «325e», без «Coupe» и «5-Speed»). Не чипсет шасси (у BaT в
 * заголовке его обычно нет) — только то, что буквально написано.
 */
const MODEL_STOP_WORDS = new Set([
  "coupe", "sedan", "convertible", "wagon", "hatchback", "roadster", "targa",
  "spyder", "spider", "cabriolet", "pickup", "truck", "suv", "van", "hardtop",
  "fastback", "liftback", "shooting", "brake", "manual", "automatic",
  "dual-clutch", "transaxle", "transmission", "gearbox", "awd", "rwd", "fwd",
  "4x4", "4×4",
]);
const SPEED_WORD_RE = /^(one|two|three|four|five|six|seven|eight|nine|ten|\d+)[\s-]*speed$/i;

const guessModel = (title, make) => {
  const match = title.match(/\b(19|20)\d{2}\b\s+(.+)$/);
  let rest = match ? match[2] : title;
  if (rest.startsWith(make))
    rest = rest.slice(make.length).trim();

  const words = [];
  for (const word of rest.split(/\s+/)) {
    if (MODEL_STOP_WORDS.has(word.toLowerCase()) || SPEED_WORD_RE.test(word))
      break;
    words.push(word);
  }
  return words.join(" ") || null;
};

/*
 * «Five-Speed Manual Transmission», «Six-Speed Manual Transaxle»,
 * «Seven-Speed Dual-Clutch Automatic Transaxle» — у BaT в заголовке
 * пункта, не отдельными полями. Превращаем в короткое «5-ступенчатая
 * механика» вместо сырого английского текста под заголовком
 * «Коробка передач».
 */
const SPEED_NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const describeTransmission = (raw) => {
  if (!raw)
    return null;

  const speedMatch = raw.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)[\s-]*speed/i);
  const speed = speedMatch ? (SPEED_NUMBER_WORDS[speedMatch[1].toLowerCase()] ?? Number(speedMatch[1])) : null;
  const isDualClutch = /dual-clutch/i.test(raw);
  const isAutomatic = !isDualClutch && /automatic/i.test(raw);
  const isManual = /manual/i.test(raw);

  if (isDualClutch)
    return speed ? `${speed}-ступенчатый робот (DCT)` : "Робот (DCT)";
  if (isAutomatic)
    return speed ? `${speed}-ступенчатый автомат` : "Автомат";
  if (isManual)
    return speed ? `${speed}-ступенчатая механика` : "Механика";

  return raw; // тип не распознали — показываем как есть, не выдумываем
};

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

  return { vin, mileage, transmission: describeTransmission(transmissionRaw), ownerType };
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
  } = {}) {
    Object.assign(this, { fetchImpl, dataDir, now, log });
  }

  lotsFile() {
    return path.join(this.dataDir, "lots.json");
  }

  detailsFile() {
    return path.join(this.dataDir, "lot-details.json");
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
    const missing = lots.filter(lot => lot.status !== "ended" && !cache[lot.id]);
    let fetched = 0;

    for (const lot of missing) {
      try {
        cache[lot.id] = await this.fetchLotDetails(lot.sourceUrl);
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
    const items = await this.fetchActiveListings();
    const lots = items
      .filter(item => !(item.categories || []).some(id => EXCLUDE_CATEGORY_IDS.has(String(id))))
      .map(item => toRareLot(item, now));

    this.log(`BRONVERA Rare: собрано ${lots.length} лотов с Bring a Trailer (из ${items.length} активных объявлений всех категорий)`);

    const detailsCache = await this.fetchMissingDetails(lots, this.loadDetailsCache());
    this.saveDetailsCache(detailsCache);

    const enriched = lots.map(lot => ({ ...lot, ...(detailsCache[lot.id] || {}) }));

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(
      this.lotsFile(),
      JSON.stringify({ updatedAt: new Date(now).toISOString(), source: "Bring a Trailer", count: enriched.length, lots: enriched }, null, 2),
    );

    return enriched;
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
