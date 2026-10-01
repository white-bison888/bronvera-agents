const fs = require("fs");
const path = require("path");
const { applyLiteBrowsing } = require("../providers/lite-browsing");
const { meterBrowserContext } = require("../costs/ledger");
const { guessMake, guessModel } = require("./title-parser");

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
const CLOSING_SOON_MS = 48 * 3600 * 1000;

// Курс ЕЦБ/api.frankfurter.dev на 01.10.2026, см. costs/prices.js (eurUsd) — тот же источник, не обновляется сам.
const FX_TO_USD = {
  "US$": 1,
  "£": 1.32338, // 1 / 0.75565 GBP
  "€": 1.12979, // 1 / 0.88511 EUR
  "A$": 0.69505, // 1 / 1.4388 AUD
  "NZ$": 0.56153, // 1 / 1.7809 NZD
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

class CollectingCarsScraper {
  constructor({
    dataDir = path.join(process.cwd(), "data", "rare", "collectingcars"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null,
    fetchCards = null, // переопределяется в тестах — () => [{ href, imgAlt, imgSrc, text }, ...], без Playwright
  } = {}) {
    Object.assign(this, { dataDir, now, log, alerts, fetchCards });
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
