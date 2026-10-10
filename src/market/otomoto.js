/*
 * Цены перепродажи в Польше (07.10.2026): объявления otomoto.pl.
 *
 * Страницы выдачи разрешены в robots.txt (закрыты только /api/ и /ajax/), а
 * список объявлений приходит в самой странице готовым JSON (__NEXT_DATA__):
 * цена в злотых или евро, пробег в км, год, топливо. Идём по страницам с
 * паузой, как человек, и берём только первые страницы выдачи.
 *
 * Цены на Otomoto — брутто, с НДС: так видит цену покупатель в Польше.
 */
const PAGE_PAUSE_MS = 1500;
const MAX_PAGES = 3;

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const slug = value => String(value || "")
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

// Слова модели для проверки заголовка: «Model 3» → ["model", "3"].
const words = value => String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const param = (node, key) => (node.parameters || []).find(item => item.key === key)?.value ?? null;

/* Объявления из JSON страницы; пустой список, если страница отдала не выдачу. */
const adsFromHtml = (html) => {
  const match = String(html || "").match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);

  if (!match)
    return { ads: [], total: 0 };

  let data;

  try {
    data = JSON.parse(match[1]);
  } catch {
    return { ads: [], total: 0 };
  }

  const state = data?.props?.pageProps?.urqlState || {};

  for (const entry of Object.values(state)) {
    let body = entry?.data;

    try {
      body = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
      continue;
    }

    const search = body?.advertSearch;

    if (search && Array.isArray(search.edges))
      return { ads: search.edges.map(edge => edge.node).filter(Boolean), total: Number(search.totalCount) || 0 };
  }

  return { ads: [], total: 0 };
};

class OtomotoSource {
  constructor({ fx, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 25000 } = {}) {
    this.name = "otomoto.pl";
    this.fx = fx;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
  }

  async page(url) {
    const response = await this.fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html", "Accept-Language": "pl-PL,pl;q=0.9" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // 404 — такой модели в адресе нет; для остальных ошибок страница не отдаёт выдачу.
    if (response.status === 404)
      return { ads: [], total: 0 };

    if (!response.ok)
      throw new Error(`otomoto.pl ответил ${response.status}`);

    return adsFromHtml(await response.text());
  }

  async search(make, model, yearFrom, yearTo) {
    const makeSlug = slug(make);
    const modelSlug = slug(model);

    if (!makeSlug)
      return { matched: false, label: null, listings: [] };

    const query = `search%5Bfilter_float_year%3Afrom%5D=${yearFrom}&search%5Bfilter_float_year%3Ato%5D=${yearTo}`;
    const base = `https://www.otomoto.pl/osobowe/${makeSlug}${modelSlug ? `/${modelSlug}` : ""}`;
    const wanted = words(model);
    const kept = [];

    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      if (pageNumber > 1)
        await this.sleep(PAGE_PAUSE_MS);

      const { ads, total } = await this.page(`${base}?${query}&page=${pageNumber}`);

      /*
       * Адрес с неизвестной моделью площадка превращает в выдачу всей марки
       * (так «ford/f-150» дал 18 636 Ford). Оставляем только те объявления, у
       * которых модель в самом объявлении совпала с запрошенной.
       */
      for (const ad of ads) {
        const adModel = String(param(ad, "model") || "");
        const title = words(ad.title);
        const sameModel = !wanted.length
          || adModel === modelSlug
          || wanted.every(word => title.includes(word));

        if (sameModel)
          kept.push(ad);
      }

      if (!ads.length || pageNumber * 32 >= total)
        break;
    }

    if (!kept.length)
      return { matched: false, label: null, listings: [] };

    const listings = [];

    for (const ad of kept) {
      const amount = ad.price?.amount;
      const priceUsd = amount ? await this.fx.toUsd(Number(amount.value), amount.currencyCode) : null;
      const mileage = Number(param(ad, "mileage"));
      const year = Number(param(ad, "year"));

      listings.push({
        source: this.name,
        title: ad.title || "",
        year: Number.isFinite(year) && year > 1980 ? year : null,
        mileageKm: Number.isFinite(mileage) && mileage > 0 ? mileage : null,
        priceUsd,
        city: ad.location?.city?.name || null,
        vin: null,
        url: ad.url,
      });
    }

    return { matched: true, label: `${make} ${model}`.trim(), listings };
  }
}

/*
 * Курсы PLN и EUR к доллару: официальные справочные курсы ЕЦБ через
 * frankfurter.dev (тот же сервис, что в Rare). Держим в памяти шесть часов.
 */
class PlnRates {
  constructor({ fetchImpl = fetch, ttlMs = 6 * 3600000 } = {}) {
    this.fetch = fetchImpl;
    this.ttlMs = ttlMs;
    this.cache = null;
  }

  async load() {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs)
      return this.cache.rates;

    const response = await this.fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=PLN,EUR", { signal: AbortSignal.timeout(15000) });

    if (!response.ok)
      throw new Error(`Курсы валют: сервис ответил ${response.status}`);

    const body = await response.json();

    this.cache = { rates: { USD: 1, ...body.rates }, at: Date.now() };

    return this.cache.rates;
  }

  // Сумма в USD; валюту, которой нет в курсах, не угадываем — объявление без цены.
  async toUsd(value, currency) {
    if (!Number.isFinite(value))
      return null;

    const rate = (await this.load())[String(currency || "").toUpperCase()];

    return rate ? value / rate : null;
  }
}

module.exports = { OtomotoSource, PlnRates, adsFromHtml, slug };
