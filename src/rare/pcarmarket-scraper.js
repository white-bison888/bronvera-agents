const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { applyLiteBrowsing } = require("../providers/lite-browsing");
const { meterBrowserContext } = require("../costs/ledger");
const { describeTransmission } = require("./transmission");

/*
 * BRONVERA Rare, Фаза 3 (01.10.2026): вторая площадка — PCARMARKET.
 * В отличие от BaT, открыта без прокси только с обычного адреса — с
 * сервера Hetzner (и с Cars & Bids, и с Hemmings) отдаёт Cloudflare
 * "Just a moment..." (решение Mikita: подключить через тот же
 * резидентный прокси, что уже используется для bid.cars).
 *
 * Разметка — приложение на TanStack Start: сервер отдаёт страницу уже
 * с данными внутри, одним большим <script> с гидратационным кэшем
 * React Query (самоссылающийся $R[N]=... вместо обычного JSON — так
 * SSR избегает дублирования общих объектов). Playwright тут не для
 * обхода защиты JS-перерисовкой, а потому что без браузера с прокси
 * Cloudflare вообще не пропускает — значит, страница уже полностью
 * собрана на сервере, второй отдельный запрос за данными не нужен,
 * из HTML их просто разбираем.
 *
 * Разбор ищет нужный запрос по его ключу (["basta","search",{...}]),
 * а не по индексу внутри $R — так переживает изменение порядка на
 * странице. Нужные поля уже готовы в самой выдаче (марка, модель,
 * пробег, VIN, тип продавца) — в отличие от BaT, второй заход на
 * страницу каждого лота не нужен.
 */

const AUCTIONS_URL = "https://www.pcarmarket.com/auctions";
const CLOSING_SOON_MS = 48 * 3600 * 1000;

/*
 * Данные вшиты в HTML как исполняемый JS (не JSON): self.$R = {} затем
 * последовательные $R[N] = {...}, со ссылками друг на друга. Выполняем
 * этот блок в песочнице, подставив самое необходимое вместо document/
 * window — остальной код в нём эти браузерные объекты не трогает.
 */
const parseSearchFromHtml = (html) => {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // Самый большой из блоков, где реально есть данные выдачи — нулевой $_TSR-заголовок тоже матчит "resultCount" в типах, но он маленький.
  const dataScript = scripts
    .filter(s => s.includes("resultCount") && s.includes("dehydratedQueryClient"))
    .sort((a, b) => b.length - a.length)[0];

  if (!dataScript)
    throw new Error("не нашёл блок с данными на странице PCARMARKET — вёрстка могла измениться");

  const stub = new Proxy(function stub() {}, { get: () => stub, apply: () => stub, construct: () => stub });
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.document = stub;
  sandbox.navigator = stub;
  sandbox.location = stub;
  sandbox.ReadableStream = class {};
  vm.createContext(sandbox);

  try {
    vm.runInContext(dataScript, sandbox, { timeout: 5000 });
  }
  catch (error) {
    throw new Error(`не разобрал данные PCARMARKET: ${error.message}`);
  }

  const queries = sandbox.$_TSR?.router?.dehydratedData?.dehydratedQueryClient?.queries || [];
  const query = queries.find(q => Array.isArray(q.queryKey) && q.queryKey[0] === "basta" && q.queryKey[1] === "search");

  if (!query)
    throw new Error("не нашёл выдачу поиска в данных страницы PCARMARKET");

  return query.state.data.search;
};

const centsToUsd = cents => typeof cents === "number" ? Math.round(cents) / 100 : null;

const ownerTypeOf = (raw) => {
  if (raw === "Private Party")
    return "Частное лицо";
  if (raw === "Dealer")
    return "Дилер";
  return raw || null;
};

const milesOf = (value, unit) => {
  if (typeof value !== "number" || !Number.isFinite(value))
    return null;
  return /km\b|kilomet/i.test(unit || "") ? Math.round(value / 1.60934) : Math.round(value);
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

// slugFullPath вида "pcar/<slug-лота>/<slug-заголовка>" — на сайте ссылка только на средний кусок.
const lotUrl = (slugFullPath) => {
  const parts = String(slugFullPath || "").split("/");
  return parts[1] ? `https://www.pcarmarket.com/auction/${parts[1]}` : null;
};

// 0 здесь значит «не выставлена», а не «ноль долларов» — как и у текущей ставки без торгов.
const estimateOf = cents => typeof cents === "number" && cents > 0 ? centsToUsd(cents) : null;

const toRareLot = (node, now) => {
  const data = node.schema?.data || {};
  const closesAt = node.dates?.closingEnd || null;

  return {
    id: `pcarmarket-${node.id}`,
    title: node.title,
    make: data.make || null,
    model: data.model || null,
    source: "PCARMARKET",
    sourceUrl: lotUrl(node.slugFullPath),
    mileage: milesOf(data.odometerValue, data.odometerUnit),
    transmission: describeTransmission(data.transmission),
    vin: data.vin || null,
    ownerType: ownerTypeOf(data.sellerType),
    estimateMin: estimateOf(node.estimates?.low),
    estimateMax: estimateOf(node.estimates?.high),
    currentBid: centsToUsd(node.currentBid),
    closesAt,
    status: statusOf(closesAt, now),
    photoUrl: node.images?.[0]?.url || null,
  };
};

class PcarmarketScraper {
  constructor({
    dataDir = path.join(process.cwd(), "data", "rare", "pcarmarket"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null,
    fetchPage = null, // переопределяется в тестах — (pageNum) => html, без Playwright
  } = {}) {
    Object.assign(this, { dataDir, now, log, alerts, fetchPage });
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
      return { source: "PCARMARKET", lastRunAt: null, ok: null, count: null, error: null };
    }
  }

  readLots() {
    try {
      return JSON.parse(fs.readFileSync(this.lotsFile(), "utf8"));
    }
    catch {
      return { updatedAt: null, source: "PCARMARKET", count: 0, lots: [] };
    }
  }

  /*
   * Один заход через Playwright + резидентный прокси (тот же, что у
   * bid.cars) — без прокси Cloudflare отдаёт только страницу проверки.
   * Картинки и шрифты не грузим (applyLiteBrowsing) — страница нужна
   * только за текстом, а трафик через прокси платный.
   */
  async fetchPageHtml(pageNum) {
    if (this.fetchPage)
      return this.fetchPage(pageNum);

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
      const meter = meterBrowserContext(context, { source: "выдача PCARMARKET", viaProxy: Boolean(proxy) });

      const page = await context.newPage();
      const url = pageNum > 1 ? `${AUCTIONS_URL}?page=${pageNum}` : AUCTIONS_URL;
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      if (!response || response.status() >= 400)
        throw new Error(`PCARMARKET ответил ${response ? response.status() : "без ответа"}`);

      /*
       * Не page.content(): фреймворк сайта сам вычищает блок с данными
       * из DOM сразу после гидратации (self.$_TSR удаляется), и к
       * моменту чтения DOM их там уже нет, хотя они честно пришли в
       * первом ответе. Берём сырой ответ на сам переход — то, что
       * прислал сервер, до какой-либо работы клиентского JS.
       */
      const html = (await response.body()).toString("utf8");
      await meter.finish();
      return html;
    }
    finally {
      await browser.close();
    }
  }

  async fetchActiveListings() {
    const firstHtml = await this.fetchPageHtml(1);
    const first = parseSearchFromHtml(firstHtml);
    const edges = [...first.edges];
    const totalPages = first.pageInfo?.totalPages || 1;

    for (let p = 2; p <= totalPages; p += 1) {
      const html = await this.fetchPageHtml(p);
      edges.push(...parseSearchFromHtml(html).edges);
    }

    // Watches/Parts&Memorabilia — не "редкая машина" в смысле этого сервиса.
    return edges.map(e => e.node).filter(node => node.schema?.data?.schemaName === "Vehicle");
  }

  async run() {
    const now = this.now();
    const previousIds = new Set(this.readLots().lots.map(lot => lot.id));

    try {
      const nodes = await this.fetchActiveListings();
      const lots = nodes.map(node => toRareLot(node, now));

      this.log(`BRONVERA Rare: собрано ${lots.length} лотов с PCARMARKET`);

      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.lotsFile(),
        JSON.stringify({ updatedAt: new Date(now).toISOString(), source: "PCARMARKET", count: lots.length, lots }, null, 2),
      );

      this.writeStatus({ source: "PCARMARKET", lastRunAt: new Date(now).toISOString(), ok: true, count: lots.length, error: null });

      if (this.alerts) {
        const newLots = lots.filter(lot => !previousIds.has(lot.id));
        const allLotsById = new Map(lots.map(lot => [lot.id, lot]));
        await this.alerts.checkAfterRun({ newLots, allLotsById }).catch(error => this.log("BRONVERA Rare: ошибка алертов (PCARMARKET):", error.message));
      }

      return lots;
    }
    catch (error) {
      this.writeStatus({ source: "PCARMARKET", lastRunAt: new Date(now).toISOString(), ok: false, count: null, error: error.message });
      throw error;
    }
  }

  start(intervalMs = 24 * 3600 * 1000) {
    if (this.timer)
      return;

    const tick = () => this.run().catch(error => console.error("PcarmarketScraper error:", error.message));

    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = PcarmarketScraper;
