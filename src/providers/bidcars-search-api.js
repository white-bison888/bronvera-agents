/*
 * Выдача поиска bid.cars приходит на страницу готовым списком из
 * /app/search/request: прогноз цены, полное имя продавца, тип повреждения,
 * документ на машину. Разметка карточек отдаёт то же самое обрезанным
 * («State Farm Grou...») или не отдаёт вовсе, поэтому ежедневный отбор
 * берёт данные из ответа, а не из HTML.
 *
 * За один заход доступны только первые 50 лотов: кнопку «Load More»
 * Cloudflare закрывает (403 и на клик, и на прямой запрос второй
 * страницы). Выдача отсортирована по времени торгов, ближайшие первыми,
 * поэтому каталог режется на части так, чтобы каждая часть покрывала
 * ближайшие дни.
 */

const { meterBrowserContext } = require("../costs/ledger");

const SEARCH_REQUEST_PATH = "/app/search/request";

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const money = (value) => {
  if (value === null || value === undefined || value === "")
    return null;

  const number = Number(String(value).replace(/[^\d.]/g, ""));

  return Number.isFinite(number) && String(value).match(/\d/) ? number : null;
};

const positive = (value) => {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : null;
};

/*
 * «Tue 15 Sep, 15:30 GMT+2» — время закрытия предварительных ставок, оно же
 * начало торгов. Года в строке нет: берём год выдачи и переносим на
 * следующий, если месяц уже далеко позади (выдача в конце декабря).
 */
const parseCloseTime = (text, fetchedAt) => {
  const match = String(text || "").match(
    /(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{1,2}):(\d{2})\s+GMT([+-]\d{1,2})(?::?(\d{2}))?/
  );

  if (!match)
    return null;

  const [, day, monthName, hour, minute, offsetHours, offsetMinutes] = match;
  const month = MONTHS[monthName.toLowerCase()];

  if (month === undefined)
    return null;

  let year = fetchedAt.getUTCFullYear();

  if (month < fetchedAt.getUTCMonth() - 6)
    year += 1;

  const sign = offsetHours.startsWith("-") ? -1 : 1;
  const offset = Number(offsetHours) * 60 + sign * Number(offsetMinutes || 0);

  const utc = Date.UTC(year, month, Number(day), Number(hour), Number(minute)) - offset * 60000;

  return new Date(utc);
};

const saleDateOf = (item, fetchedAt) => {
  const parsed = parseCloseTime(item.prebid_close_time_lang?.en, fetchedAt);

  if (parsed)
    return parsed.toISOString();

  const left = Number(item.time_left);

  if (!Number.isFinite(left))
    return null;

  // Остаток в секундах от момента выдачи; до минуты, как на площадке.
  const at = new Date(fetchedAt.getTime() + left * 1000);

  at.setUTCSeconds(0, 0);

  return at.toISOString();
};

/*
 * Марку и модель берём из tag («2023-Tesla-Model-Y-<VIN>»): так же их
 * получает разбор адреса лота, и записи из двух источников совпадают.
 */
const splitTag = (item, make) => {
  const parts = String(item.tag || "").split("-").filter(Boolean);
  const year = Number(parts[0]);

  if (!Number.isInteger(year))
    return { year: null, make: make || null, model: null };

  let rest = parts.slice(1);

  if (item.vin && rest[rest.length - 1] === item.vin)
    rest = rest.slice(0, -1);

  const makeParts = make ? String(make).split(/\s+/) : rest.slice(0, 1);
  const matchesMake = makeParts.every(
    (word, index) => String(rest[index] || "").toLowerCase() === word.toLowerCase()
  );

  return {
    year,
    make: matchesMake ? rest.slice(0, makeParts.length).join(" ") : make || rest[0] || null,
    model: (matchesMake ? rest.slice(makeParts.length) : rest.slice(1)).join(" ") || null,
  };
};

const mapSearchItem = (item, { fetchedAt = new Date(), make = null } = {}) => {
  if (!item || !item.lot)
    return null;

  const names = splitTag(item, make);
  const startCode = String(item.start_code || "");
  const images = Object.values(item.img_large || item.img || {}).filter(Boolean);

  return {
    source: "bid.cars",
    vehicleType: "car",
    auction: String(item.lot).startsWith("1-") ? "Copart" : "IAAI",
    lotNumber: String(item.lot),
    vin: item.vin || null,
    make: names.make,
    model: names.model,
    year: names.year,
    trim: item.name_long || null,
    currentBid: money(item.prebid_price),
    currency: "USD",
    // Одометр в выдаче в милях, как и в остальном реестре.
    mileage: positive(item.odometer),
    primaryDamage: item.loss_type || null,
    secondaryDamage: item.primary_damage || null,
    keyPresence: item.specs?.key_info || null,
    buyNowUsd: money(item.buy_now_price),
    seller: item.seller_long || item.seller || null,
    runAndDrive: /run\s*(\/|and)\s*drive/i.test(startCode) ? "Run and Drive" : startCode || null,
    titleType: item.sale_document_split || item.sale_document_external || null,
    titleDocument: item.sale_document_external || null,
    location: item.location || null,
    fuelType: /tesla/i.test(names.make || "") ? "Electric" : null,
    saleDate: saleDateOf(item, fetchedAt),
    timeLeftMs: Number.isFinite(Number(item.time_left)) ? Number(item.time_left) * 1000 : null,
    auctionEstimateMin: positive(item.estimated_min),
    auctionEstimateMax: positive(item.estimated_max),
    url: item.tag ? `https://bid.cars/en/lot/${item.lot}/${item.tag}` : null,
    images,
    sourceFetchedAt: fetchedAt.toISOString(),
  };
};

class SearchSliceError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "SearchSliceError";
    this.status = status;
  }
}

/*
 * Один заход на страницу выдачи. Список перехватываем из ответа, который
 * страница запрашивает сама, — отдельный запрос из скрипта Cloudflare
 * режет.
 */
const fetchSearchSlice = async (url, options = {}) => {
  const { chromium } = options.playwright || require("playwright");
  const timeoutMs = options.timeoutMs || 60000;

  const proxy = process.env.PROXY_SERVER
    ? {
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      }
    : undefined;

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
    ...(proxy ? { proxy } : {}),
  });

  let meter = null;

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1440, height: 1000 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      ignoreHTTPSErrors: Boolean(proxy),
    });

    meter = meterBrowserContext(context, { source: "выдача bid.cars", viaProxy: Boolean(proxy) });

    const page = await context.newPage();

    let listing = null;
    let count = null;

    page.on("response", async (response) => {
      if (!response.url().includes(SEARCH_REQUEST_PATH) || response.status() >= 400)
        return;

      try {
        const body = JSON.parse(await response.text());

        if (body.count)
          count = body.count;
        else if (Array.isArray(body.data) && !listing)
          listing = body;
      } catch {
        // Не JSON — страница проверки, ждём настоящий ответ.
      }
    });

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const status = response ? response.status() : null;

    if (!response || status >= 400)
      throw new SearchSliceError(`Bid.Cars ответил ${status ?? "без ответа"}`, status);

    const deadline = Date.now() + 30000;

    while (!listing && Date.now() < deadline)
      await page.waitForTimeout(500);

    if (!listing)
      throw new SearchSliceError("Bid.Cars не прислал список лотов", status);

    // Счётчик приходит отдельным запросом следом за списком.
    for (let waited = 0; !count && waited < 4000; waited += 500)
      await page.waitForTimeout(500);

    return {
      httpStatus: status,
      url,
      items: listing.data,
      perPage: Number(listing.per_page) || listing.data.length,
      hasMore: Boolean(listing.next_page_url),
      activeCount: Number.isFinite(Number(count?.active)) ? Number(count.active) : null,
    };
  } finally {
    await meter?.finish().catch(() => {});
    await browser.close();
  }
};

module.exports = {
  SEARCH_REQUEST_PATH,
  SearchSliceError,
  fetchSearchSlice,
  mapSearchItem,
  parseCloseTime,
};
