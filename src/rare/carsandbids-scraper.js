const fs = require("fs");
const path = require("path");
const { applyLiteBrowsing } = require("../providers/lite-browsing");
const { meterBrowserContext } = require("../costs/ledger");
const { guessMake, guessModel } = require("./title-parser");
const { loadSoldArchive, readSoldArchiveCached, saveSoldArchive, yearFromTitle } = require("./sold-archive");

/*
 * BRONVERA Rare, Фаза 3 (01.10.2026): четвёртая площадка — Cars & Bids.
 * Как и PCARMARKET, закрыта Cloudflare для адреса дата-центра (сервер
 * Hetzner) — тем же managed-challenge, что блокировал прямой curl даже
 * с обычного адреса. Решение прежнее: Playwright + резидентный прокси,
 * который уже используется для bid.cars и PCARMARKET.
 *
 * Данные приходят готовым JSON (GET /v2/autos/auctions), но запрос
 * подписан (timestamp+signature, считается в клиентском JS) — повторить
 * его напрямую нельзя. Вместо этого даём реальной странице сделать
 * запрос самой и перехватываем готовый ответ, тем же приёмом, что уже
 * есть в проекте для выдачи bid.cars (bidcars-search-api.js). Лента
 * непрерывная (аукционы идут постоянно, не по расписанию) — ближе к
 * BaT/PCARMARKET, чем к RM Sotheby's: есть currentBid и живой статус.
 *
 * Пагинация — офсетом (offset=0,52,104…), страница подгружает лоты по
 * скроллу; воспроизводим это скроллом в headless-браузере, собирая
 * каждый перехваченный ответ.
 */

const AUCTIONS_URL = "https://carsandbids.com/auctions";
const PAST_AUCTIONS_URL = "https://carsandbids.com/past-auctions";
const PAGE_LIMIT = 52;
const CLOSING_SOON_MS = 48 * 3600 * 1000;

// 1 и 2 — единственные коды, встреченные в разведке (31.10.2026); третий код, если появится, останется null, а не угадывается.
const TRANSMISSION_LABELS = { 1: "Автомат", 2: "Механика" };

const slugify = title =>
  title.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const parseMileage = (raw) => {
  const match = String(raw || "").match(/([\d,]+)\s*Miles?/i);
  return match ? Math.round(Number(match[1].replace(/,/g, ""))) : null;
};

const photoUrlOf = (photo) => {
  if (!photo?.base_url || !photo?.path)
    return null;
  return `https://${photo.base_url}/${photo.path}`;
};

/*
 * Баг от Mikita 01.10.2026 (тот же класс, что у BaT): auction_end в
 * выдаче — расписанное время, а Cars & Bids, как и BaT, продлевает торги
 * при ставке в последние секунды и явно держит сам лот в статусе "live",
 * пока не подведёт итог. Проверено на двух настоящих лотах 01.10: время
 * по расписанию уже прошло, площадка всё ещё отвечает status: "live".
 * Доверяем статусу площадки, а не только времени — иначе лот помечается
 * "ended" с цифрой, которая ещё может вырасти. Отдельный заход на
 * страницу лота за точной ценой закрытия (как у BaT) здесь не делаем —
 * решено не тратить платный трафик через прокси на то, что и так само
 * исчезает из выдачи, как только площадка решит.
 */
const statusOf = (closesAt, now, rawStatus) => {
  if (rawStatus && rawStatus !== "live")
    return "ended";
  if (!closesAt)
    return "open";
  const end = Date.parse(closesAt);
  if (!Number.isFinite(end))
    return "open";
  if (end <= now)
    return "closing"; // время по расписанию вышло, но площадка ещё не подвела итог
  if (end - now <= CLOSING_SOON_MS)
    return "closing";
  return "open";
};

const toRareLot = (item, now) => {
  const title = item.title;
  const make = guessMake(title);
  const closesAt = item.auction_end || null;

  return {
    id: `carsandbids-${item.id}`,
    title,
    make,
    model: guessModel(title, make),
    source: "Cars & Bids",
    sourceUrl: `https://carsandbids.com/auctions/${item.id}/${slugify(title)}`,
    mileage: parseMileage(item.mileage),
    transmission: TRANSMISSION_LABELS[item.transmission] || null,
    vin: null, // не в выдаче — отдельный заход на страницу лота добавил бы платный трафик через прокси
    ownerType: null,
    estimateMin: null, // площадка оценок не даёт, только текущую ставку
    estimateMax: null,
    // sale_amount — настоящая цена сделки (например, Buy It Now обходит
    // текущую ставку совсем) — приоритетнее current_bid, когда площадка
    // её уже проставила.
    currentBid: typeof item.sale_amount === "number" ? item.sale_amount : (typeof item.current_bid === "number" ? item.current_bid : null),
    closesAt,
    status: statusOf(closesAt, now, item.status),
    photoUrl: photoUrlOf(item.main_photo),
  };
};

/*
 * Вкладка Stats (01.10.2026, просьба Mikita): /past-auctions отдаёт
 * закрытые лоты отдельным статусом — "sold" и "sold_after" (сделка
 * состоялась, в т.ч. после торгов по договорённости), "reserve_not_met"
 * (резерв не достигнут, лот не продан — сохраняем как есть, не продан),
 * "canceled" (снят с продажи — в архив не идёт, не настоящий результат
 * торгов). sale_amount — настоящая цена сделки, current_bid — запасной
 * вариант для reserve_not_met.
 */
const SOLD_STATUSES = new Set(["sold", "sold_after"]);

const toSoldLot = (item) => {
  const title = item.title;
  const make = guessMake(title);

  return {
    id: `carsandbids-${item.id}`,
    title,
    make,
    model: guessModel(title, make),
    year: yearFromTitle(title),
    source: "Cars & Bids",
    sourceUrl: `https://carsandbids.com/auctions/${item.id}/${slugify(title)}`,
    soldAt: item.auction_end || null,
    salePrice: typeof item.sale_amount === "number" ? item.sale_amount : (typeof item.current_bid === "number" ? item.current_bid : null),
    sold: SOLD_STATUSES.has(item.status),
    estimateMin: null,
    estimateMax: null,
    mileage: parseMileage(item.mileage),
    transmission: TRANSMISSION_LABELS[item.transmission] || null,
    conditionFacts: [],
    photoUrl: photoUrlOf(item.main_photo),
  };
};

class CarsAndBidsScraper {
  constructor({
    dataDir = path.join(process.cwd(), "data", "rare", "carsandbids"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null,
    fetchPage = null, // переопределяется в тестах — (offset) => [auction, ...], без Playwright
    fetchClosedPage = null, // переопределяется в тестах — () => [auction, ...], без Playwright
  } = {}) {
    Object.assign(this, { dataDir, now, log, alerts, fetchPage, fetchClosedPage });
  }

  lotsFile() {
    return path.join(this.dataDir, "lots.json");
  }

  soldFile() {
    return path.join(this.dataDir, "sold.json");
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
      return { source: "Cars & Bids", lastRunAt: null, ok: null, count: null, error: null };
    }
  }

  readLots() {
    try {
      return JSON.parse(fs.readFileSync(this.lotsFile(), "utf8"));
    }
    catch {
      return { updatedAt: null, source: "Cars & Bids", count: 0, lots: [] };
    }
  }

  /*
   * Общий сеанс в браузере через прокси — без него Cloudflare отдаёт
   * только страницу проверки. callback получает подготовленную страницу
   * и сам решает, что на ней делать (разные сценарии у /auctions и
   * /past-auctions, см. fetchAllAuctions и fetchPastAuctions).
   */
  async withBrowserPage(label, callback) {
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
      const meter = meterBrowserContext(context, { source: label, viaProxy: Boolean(proxy) });

      const page = await context.newPage();
      const result = await callback(page);
      await meter.finish();
      return result;
    }
    finally {
      await browser.close();
    }
  }

  /*
   * Открываем ленту и скроллим, пока не соберём все активные лоты (сайт
   * подгружает их офсетом сам, запрос подписывается его собственным JS —
   * не воспроизводим подпись, просто читаем то, что он сам получил).
   */
  async fetchAllAuctions() {
    if (this.fetchPage) {
      const pages = [];
      for (let offset = 0; ; offset += PAGE_LIMIT) {
        const items = await this.fetchPage(offset);
        if (!items.length)
          break;
        pages.push(...items);
        if (items.length < PAGE_LIMIT)
          break;
      }
      return pages;
    }

    return this.withBrowserPage("выдача Cars & Bids", async (page) => {
      const byId = new Map();
      let total = Infinity;

      page.on("response", async (response) => {
        if (!response.url().includes("/v2/autos/auctions?sort=1"))
          return;
        try {
          const data = await response.json();
          total = data.total ?? total;
          for (const item of data.auctions || [])
            byId.set(item.id, item);
        }
        catch {
          // не JSON — не тот ответ, пропускаем
        }
      });

      const firstPage = page.waitForResponse(r => r.url().includes("/v2/autos/auctions?sort=1"), { timeout: 45000 });
      await page.goto(AUCTIONS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await firstPage.catch(() => {}); // сам ответ уже разобран в обработчике выше — просто дожидаемся его

      /*
       * Скроллим, пока не соберём все активные лоты. Не каждый скролл
       * догружает страницу — датчик подгрузки срабатывает не на каждом
       * шаге, через один (проверено разведкой), так что один «пустой»
       * скролл подряд — это нормально, не конец ленты. Останавливаемся
       * только после нескольких подряд скроллов без единого нового
       * ответа — вот это уже значит, что подгружать больше нечего.
       */
      let stall = 0;
      for (let i = 0; i < 60 && byId.size < total && stall < 4; i += 1) {
        const next = page.waitForResponse(r => r.url().includes("/v2/autos/auctions?sort=1"), { timeout: 10000 });
        await page.mouse.wheel(0, 3000);
        const arrived = await next.then(() => true).catch(() => false);
        stall = arrived ? 0 : stall + 1;
      }

      return [...byId.values()];
    });
  }

  /*
   * Вкладка Stats (01.10.2026): /past-auctions отдаёт свежезакрытые лоты
   * первой страницей (сортировка — от недавних, проверено разведкой),
   * без подгрузки по скроллу — одного перехваченного ответа достаточно
   * на суточный прогон, глубже не листаем специально (не нужна вся
   * история, только то, что закрылось со вчера).
   */
  async fetchPastAuctions() {
    if (this.fetchClosedPage)
      return this.fetchClosedPage();

    return this.withBrowserPage("результаты Cars & Bids", async (page) => {
      const response = page.waitForResponse(r => r.url().includes("status=closed"), { timeout: 45000 });
      await page.goto(PAST_AUCTIONS_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      const data = await (await response).json();
      return data.auctions || [];
    });
  }

  /*
   * Архив копится, не перезаписывается: canceled — не настоящий результат
   * торгов, в архив не идёт; остальные статусы добавляются один раз.
   */
  async updateSoldArchive() {
    const items = await this.fetchPastAuctions();
    const archive = loadSoldArchive(this.soldFile());
    let added = 0;

    for (const item of items) {
      if (item.status === "canceled")
        continue;
      const soldLot = toSoldLot(item);
      if (!archive[soldLot.id]) {
        archive[soldLot.id] = soldLot;
        added += 1;
      }
    }

    if (added) {
      saveSoldArchive(this.soldFile(), archive);
      this.log(`BRONVERA Rare: добавил ${added} проданных лотов Cars & Bids в архив (всего ${Object.keys(archive).length})`);
    }

    return added;
  }

  async run() {
    const now = this.now();
    const previousIds = new Set(this.readLots().lots.map(lot => lot.id));

    try {
      const items = await this.fetchAllAuctions();
      const lots = items.map(item => toRareLot(item, now));

      this.log(`BRONVERA Rare: собрано ${lots.length} лотов с Cars & Bids`);

      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.lotsFile(),
        JSON.stringify({ updatedAt: new Date(now).toISOString(), source: "Cars & Bids", count: lots.length, lots }, null, 2),
      );

      this.writeStatus({ source: "Cars & Bids", lastRunAt: new Date(now).toISOString(), ok: true, count: lots.length, error: null });

      // Архив проданных для Stats — не должен ронять весь прогон активных лотов, если /past-auctions подвела.
      await this.updateSoldArchive().catch(error => this.log("BRONVERA Rare: не добрал архив продаж Cars & Bids:", error.message));

      if (this.alerts) {
        const newLots = lots.filter(lot => !previousIds.has(lot.id));
        const allLotsById = new Map(lots.map(lot => [lot.id, lot]));
        await this.alerts.checkAfterRun({ newLots, allLotsById }).catch(error => this.log("BRONVERA Rare: ошибка алертов (Cars & Bids):", error.message));
      }

      return lots;
    }
    catch (error) {
      this.writeStatus({ source: "Cars & Bids", lastRunAt: new Date(now).toISOString(), ok: false, count: null, error: error.message });
      throw error;
    }
  }

  start(intervalMs = 24 * 3600 * 1000) {
    if (this.timer)
      return;

    const tick = () => this.run().catch(error => console.error("CarsAndBidsScraper error:", error.message));

    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = CarsAndBidsScraper;
