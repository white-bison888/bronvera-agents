const fs = require("fs");
const path = require("path");
const { applyLiteBrowsing } = require("../providers/lite-browsing");
const { meterBrowserContext } = require("../costs/ledger");
const { guessMake, guessModel } = require("./title-parser");
const { loadSoldArchive, saveSoldArchive, yearFromTitle } = require("./sold-archive");

/*
 * BRONVERA Rare, Фаза 3 (01.10.2026): шестая площадка — Collecting Cars.
 * Закрыта тем же Cloudflare managed-challenge, что PCARMARKET/Cars & Bids
 * для адреса дата-центра — тот же резидентный прокси. В отличие от них,
 * данные не в отдельном JSON-ответе — уже готовый HTML с текстом карточки
 * (заголовок, цена, обратный отсчёт, страна, число ставок), разбираем
 * прямо из DOM страницы /buy.
 *
 * Лоты из разных стран (UK, Австралия, Новая Зеландия, США, Европа) —
 * цена у каждого в своей валюте (£/A$/NZ$/US$/€), не одной сквозной.
 * Переводим в USD по курсу (как eurUsd в costs/prices.js — фиксированный
 * на дату, не живой; обновлять вручную, если сильно разойдётся).
 */

const BUY_URL = "https://collectingcars.com/buy";
const SEARCH_URL = "https://dora.production.collecting.com/multi_search";
const SOLD_PER_PAGE = 250;
const SOLD_MAX_PAGES = 8; // потолок на один заход: первый раз добираем историю (до 2000 лотов), дальше хватает одной страницы
const CLOSING_SOON_MS = 48 * 3600 * 1000;

// Курс ЕЦБ/api.frankfurter.dev на 01.10.2026, см. costs/prices.js (eurUsd) — тот же источник, не обновляется сам.
const FX_TO_USD = {
  "US$": 1,
  "£": 1.32338, // 1 / 0.75565 GBP
  "€": 1.12979, // 1 / 0.88511 EUR
  "A$": 0.69505, // 1 / 1.4388 AUD
  "NZ$": 0.56153, // 1 / 1.7809 NZD
};

// Для архива продаж: у проданных лотов валюта приходит кодом (gbp/aud/…), не знаком — тот же курс на 01.10.2026.
const FX_BY_CODE = {
  usd: 1,
  gbp: FX_TO_USD["£"],
  eur: FX_TO_USD["€"],
  aud: FX_TO_USD["A$"],
  nzd: FX_TO_USD["NZ$"],
  chf: 1.1972, // 1 / 0.83528 CHF
};

const parsePriceUsd = (text) => {
  const match = String(text || "").match(/(NZ\$|A\$|US\$|£|€)([\d,]+)/);
  if (!match)
    return null;
  const rate = FX_TO_USD[match[1]];
  if (!rate)
    return null;
  return Math.round(Number(match[2].replace(/,/g, "")) * rate);
};

// «00:02:56» — не дата закрытия, а сколько осталось прямо сейчас; считаем дату от момента разбора.
const parseClosesAt = (text, now) => {
  const match = String(text || "").match(/\b(\d{2}):(\d{2}):(\d{2})\b/);
  if (!match)
    return null;
  const ms = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
  return new Date(now + ms).toISOString();
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

const toRareLot = (card, now) => {
  const title = card.title;
  const make = guessMake(title);
  const closesAt = parseClosesAt(card.text, now);

  return {
    id: `collectingcars-${card.href.split("/").pop()}`,
    title,
    make,
    model: guessModel(title, make),
    source: "Collecting Cars",
    sourceUrl: `https://collectingcars.com${card.href}`,
    mileage: null, // не в карточке списка — только иногда в самом заголовке, ненадёжно вытаскивать
    transmission: null,
    vin: null,
    ownerType: null,
    estimateMin: null, // площадка оценок не даёт, только текущую ставку
    estimateMax: null,
    currentBid: parsePriceUsd(card.text),
    closesAt,
    status: statusOf(closesAt, now),
    photoUrl: card.imgSrc || null,
  };
};

/*
 * Вкладка Stats (02.10.2026, просьба Mikita): проданные лоты — не через
 * Cloudflare (страницы закрыты), а через тот же Typesense-поиск, которым
 * пользуется сама страница /sold (dora.production.collecting.com). Ключ —
 * поисковый ключ фронтенда, виден в любом запросе браузера к сайту, не
 * учётная запись; запросы идут напрямую, без прокси и браузера. Из индекса
 * берём только машины (не номера, запчасти, мотоциклы) и только аукционы
 * (не «купить сейчас») — в индексе нет стадии «не продан», только
 * подтверждённые продажи. Цена приходит в валюте лота: пересчитываем в USD
 * по фиксированному курсу, а исходную цену и валюту храним рядом.
 */
const SEARCH_KEY = "0I2WvLvRUeeHNaDV74u0KRlkLnhhgH9S";

const SOLD_FIELDS = "id,slug,title,mainImageUrl,currencyCode,priceSold,isSoldPriceHidden,saleFormat,lotType,productMake,productYear,modelName,dtSoldUTC,tsSoldUTC";

const toSoldLot = (doc) => {
  const rate = FX_BY_CODE[String(doc.currencyCode || "").toLowerCase()];
  if (!rate || typeof doc.priceSold !== "number" || doc.isSoldPriceHidden)
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
    soldAt: doc.dtSoldUTC ? `${doc.dtSoldUTC.replace(" ", "T")}Z` : null,
    salePrice: Math.round(doc.priceSold * rate),
    salePriceLocal: doc.priceSold,
    currency: String(doc.currencyCode).toUpperCase(),
    sold: true,
    estimateMin: null,
    estimateMax: null,
    mileage: null,
    transmission: null,
    conditionFacts: [],
    photoUrl: doc.mainImageUrl || null,
  };
};

class CollectingCarsScraper {
  constructor({
    dataDir = path.join(process.cwd(), "data", "rare", "collectingcars"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null,
    fetchCards = null, // переопределяется в тестах — () => [{ href, imgAlt, imgSrc, text }, ...], без Playwright
    fetchImpl = fetch,
  } = {}) {
    Object.assign(this, { dataDir, now, log, alerts, fetchCards, fetchImpl });
  }

  soldFile() {
    return path.join(this.dataDir, "sold.json");
  }

  readSold() {
    return Object.values(loadSoldArchive(this.soldFile()));
  }

  lotsFile() {
    return path.join(this.dataDir, "lots.json");
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

  /*
   * Один сеанс в браузере через прокси: открываем /buy и скроллим, пока
   * не соберём все карточки. Как и у Cars & Bids, подгрузка откликается
   * не на каждый скролл — терпим несколько подряд без роста, не одну.
   */
  async fetchAllCards() {
    if (this.fetchCards)
      return this.fetchCards();

    const { chromium } = require("playwright");
    const proxy = process.env.PROXY_SERVER
      ? { server: process.env.PROXY_SERVER, username: process.env.PROXY_USERNAME, password: process.env.PROXY_PASSWORD }
      : undefined;

    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
      ...(proxy ? { proxy } : {}),
    });

    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        locale: "en-US",
        viewport: { width: 1440, height: 1000 },
        extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
        ignoreHTTPSErrors: Boolean(proxy),
      });

      await applyLiteBrowsing(context);
      const meter = meterBrowserContext(context, { source: "выдача Collecting Cars", viaProxy: Boolean(proxy) });

      const page = await context.newPage();
      await page.goto(BUY_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2000);

      let before = 0;
      let stall = 0;

      for (let i = 0; i < 60 && stall < 4; i += 1) {
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(700);
        const count = await page.locator('a[href^="/for-sale/"][class*="aspect-3/2"]').count();
        stall = count === before ? stall + 1 : 0;
        before = count;
      }

      const cards = await page.$$eval('a[href^="/for-sale/"][class*="aspect-3/2"]', (els) => {
        const seen = new Set();
        return els
          .filter((el) => {
            const href = el.getAttribute("href");
            if (seen.has(href))
              return false;
            seen.add(href);
            return true;
          })
          .map((el) => {
            const card = el.closest("div.flex.flex-col.rounded-md");
            const img = el.querySelector("img");
            return {
              href: el.getAttribute("href"),
              imgAlt: img ? img.getAttribute("alt") : null,
              imgSrc: img ? img.getAttribute("src") : null,
              text: card ? card.innerText : "",
            };
          });
      });

      await meter.finish();
      return cards;
    }
    finally {
      await browser.close();
    }
  }

  async fetchSoldPage(page) {
    const response = await this.fetchImpl(`${SEARCH_URL}?x-typesense-api-key=${SEARCH_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searches: [{
          collection: "production_listings",
          q: "*",
          query_by: "title",
          include_fields: SOLD_FIELDS,
          filter_by: "(listingStage:sold) && sites:=cars && lotType:car && saleFormat:auction",
          sort_by: "tsSoldUTC:desc",
          page,
          per_page: SOLD_PER_PAGE,
        }],
      }),
    });

    if (!response.ok)
      throw new Error(`Collecting Cars (проданные, страница ${page}) ответил ${response.status}`);

    const data = await response.json();
    const result = data.results?.[0];

    if (result?.error)
      throw new Error(`Collecting Cars (проданные): ${result.error}`);

    return (result?.hits || []).map(hit => hit.document);
  }

  /*
   * Выдача идёт от свежих продаж к старым: листаем, пока на странице есть
   * хоть один лот, которого ещё нет в архиве, — полностью знакомая
   * страница значит, что дальше всё уже собрано.
   */
  async updateSoldArchive() {
    const archive = loadSoldArchive(this.soldFile());
    let added = 0;

    for (let page = 1; page <= SOLD_MAX_PAGES; page += 1) {
      const docs = await this.fetchSoldPage(page);
      let newOnPage = 0;

      for (const doc of docs) {
        const soldLot = toSoldLot(doc);
        if (soldLot && !archive[soldLot.id]) {
          archive[soldLot.id] = soldLot;
          newOnPage += 1;
        }
      }

      added += newOnPage;

      if (docs.length < SOLD_PER_PAGE || newOnPage === 0)
        break;
    }

    if (added > 0) {
      saveSoldArchive(this.soldFile(), archive);
      this.log(`BRONVERA Rare: добавил ${added} проданных лотов Collecting Cars в архив (всего ${Object.keys(archive).length})`);
    }

    return added;
  }

  async run() {
    const now = this.now();
    const previousIds = new Set(this.readLots().lots.map(lot => lot.id));

    try {
      const cards = await this.fetchAllCards();
      const lots = cards
        .filter(card => card.imgAlt && card.href && /CURRENT BID/i.test(card.text))
        .map(card => toRareLot({ ...card, title: card.imgAlt }, now));

      this.log(`BRONVERA Rare: собрано ${lots.length} лотов с Collecting Cars`);

      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.lotsFile(),
        JSON.stringify({ updatedAt: new Date(now).toISOString(), source: "Collecting Cars", count: lots.length, lots }, null, 2),
      );

      this.writeStatus({ source: "Collecting Cars", lastRunAt: new Date(now).toISOString(), ok: true, count: lots.length, error: null });

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
