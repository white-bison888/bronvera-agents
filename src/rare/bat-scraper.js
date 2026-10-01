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

  return {
    id: `bat-${item.id}`,
    title,
    make: guessMake(title),
    source: "Bring a Trailer",
    sourceUrl: item.url,
    mileage: null, // не в этом списке — только на странице лота; см. Фазу 1 в work-plan.md
    trim: null,
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

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(
      this.lotsFile(),
      JSON.stringify({ updatedAt: new Date(now).toISOString(), source: "Bring a Trailer", count: lots.length, lots }, null, 2),
    );

    this.log(`BRONVERA Rare: собрано ${lots.length} лотов с Bring a Trailer (из ${items.length} активных объявлений всех категорий)`);
    return lots;
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
