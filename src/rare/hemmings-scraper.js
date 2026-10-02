const fs = require("fs");
const path = require("path");
const { loadSoldArchive, readSoldArchiveCached, saveSoldArchive, soldArchiveLocked, yearFromTitle } = require("./sold-archive");
const { parseVehicleAttributes } = require("./sold-attrs");

/*
 * BRONVERA Rare, Фаза 3 (01.10.2026): пятая площадка — Hemmings
 * (раздел Auctions). Сам hemmings.com закрыт тем же Cloudflare managed-
 * challenge, что PCARMARKET/Cars & Bids для адреса дата-центра — но
 * выдачу лотов отдаёт отдельный поддомен api.hemmings.com, который этой
 * защитой не прикрыт вовсе. Запрос закрыт не подписью, а статичным
 * заголовком hemmings-secret — он не меняется от захода к заходу (это
 * публичный ключ из их же JS-бандла, не секрет пользователя), поэтому
 * ни браузер, ни прокси не нужны: обычный fetch с нужными заголовками.
 *
 * Выдача уже отдаёт марку/модель/VIN отдельными полями (в отличие от
 * BaT/Cars & Bids, где их приходится угадывать по заголовку) — разбор
 * title-parser.js здесь не нужен.
 */

const LISTINGS_URL = "https://api.hemmings.com/v2/search/listings";
const CLOSING_SOON_MS = 48 * 3600 * 1000;
const SOLD_PER_PAGE = 50;
const SOLD_MAX_PAGES = 4; // потолок на один заход: первый раз добираем историю, дальше хватает одной-двух страниц

/*
 * Публичный ключ фронтенда Hemmings, не секрет учётной записи — его
 * отправляет любой браузер, зашедший на обычную страницу аукционов.
 * Если площадка когда-нибудь его сменит, запрос начнёт отвечать 401 —
 * тогда и обновим.
 */
const HEMMINGS_HEADERS = {
  "Accept": "application/json",
  "hemmings-client": "1",
  "hemmings-secret": "mN5mDUiaLCnULpNgpYzHIPCEpPlFVeoprsKP15fy",
  "User-Agent": "Mozilla/5.0 (compatible; BRONVERA-Rare/1.0)",
};

const parseMoney = (raw) => {
  const match = String(raw || "").match(/[\d,]+/);
  return match ? Number(match[0].replace(/,/g, "")) : null;
};

/*
 * Та же проверка, что сделали для Cars & Bids 01.10.2026 (баг от Mikita):
 * выдача Hemmings тоже даёт собственное поле status ("live"), а торги
 * могут продлеваться — расписанное end_date в прошлом само по себе не
 * значит, что аукцион закрылся. Пока не поймали на Hemmings живого
 * примера (выдача почти всегда просто убирает закрытые лоты), но
 * архитектура — те же непрерывные торги с тем же полем, тот же риск.
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
    return "closing"; // время по расписанию вышло, площадка ещё не подвела итог
  if (end - now <= CLOSING_SOON_MS)
    return "closing";
  return "open";
};

const toRareLot = (item, now) => {
  const closesAt = item.end_date || null;

  return {
    id: `hemmings-${item.id}`,
    title: item.long_title || item.title,
    make: item.make?.name || null,
    model: item.model?.name || null,
    source: "Hemmings",
    sourceUrl: item.url,
    mileage: null, // не в выдаче — только на странице самого лота
    transmission: null,
    vin: item.vin || null,
    ownerType: (item.dealer || item.certified_dealer) ? "Дилер" : null,
    estimateMin: null, // площадка оценок не даёт, только текущую ставку
    estimateMax: null,
    currentBid: parseMoney(item.current_bid),
    closesAt,
    status: statusOf(closesAt, now, item.status),
    photoUrl: item.thumbnail?.md?.["4:3"] || item.thumbnail?.md?.full || null,
  };
};

/*
 * Вкладка Stats (02.10.2026, просьба Mikita): архив проданных лотов — не
 * через Cloudflare (который на hemmings.com блокирует даже headless-
 * браузер с хорошим прокси, проверено), а через тот же открытый
 * api.hemmings.com с параметром listing_status[]=sold, который до этого
 * не пробовали (угаданные значения вроде status=sold/closed молча
 * игнорировались API). current_price — настоящая цена сделки, отличается
 * от current_bid (вероятно, с учётом комиссии). Лоты, закрывшиеся без
 * продажи (резерв не достигнут), этим путём не найдены — у listing_status
 * есть значение reserve_not_met, но оно отдаёт ещё идущие торги
 * (status: "live"), не завершённые без сделки; архивируем только
 * подтверждённые продажи.
 */
const toSoldLot = item => ({
  id: `hemmings-${item.id}`,
  title: item.long_title || item.title,
  make: item.make?.name || null,
  model: item.model?.name || null,
  year: item.year || yearFromTitle(item.title),
  source: "Hemmings",
  sourceUrl: item.url,
  soldAt: item.sold_at || item.end_date || null,
  salePrice: parseMoney(item.current_price) ?? parseMoney(item.current_bid),
  sold: true,
  estimateMin: null,
  estimateMax: null,
  mileage: null, // не в выдаче — только на странице самого лота
  transmission: null,
  conditionFacts: [],
  ...parseVehicleAttributes(`${item.long_title || ""} ${item.title || ""}`),
  photoUrl: item.thumbnail?.md?.["4:3"] || item.thumbnail?.md?.full || null,
});

class HemmingsScraper {
  constructor({
    fetchImpl = fetch,
    dataDir = path.join(process.cwd(), "data", "rare", "hemmings"),
    now = () => Date.now(),
    log = (...args) => console.log(...args),
    alerts = null,
  } = {}) {
    Object.assign(this, { fetchImpl, dataDir, now, log, alerts });
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
      return { source: "Hemmings", lastRunAt: null, ok: null, count: null, error: null };
    }
  }

  readLots() {
    try {
      return JSON.parse(fs.readFileSync(this.lotsFile(), "utf8"));
    }
    catch {
      return { updatedAt: null, source: "Hemmings", count: 0, lots: [] };
    }
  }

  async fetchActiveListings() {
    const params = new URLSearchParams({
      adtype: "cars-for-sale",
      "listing_type[]": "hemmings_auctions_only",
      distance: "50",
      page: "1",
      per_page: "100",
      sort_by: "recommended",
      members_preview: "false",
    });

    const response = await this.fetchImpl(`${LISTINGS_URL}?${params}`, { headers: HEMMINGS_HEADERS });

    if (!response.ok)
      throw new Error(`Hemmings ответил ${response.status}`);

    const data = await response.json();
    const items = data.results || [];

    // 100 с лихвой хватает на сегодняшний объём площадки, но если вырастет — доберём остаток страницами.
    if ((data.total_count || 0) > items.length) {
      const totalPages = Math.ceil(data.total_count / 100);
      for (let page = 2; page <= totalPages; page += 1) {
        params.set("page", String(page));
        const more = await this.fetchImpl(`${LISTINGS_URL}?${params}`, { headers: HEMMINGS_HEADERS });
        if (!more.ok)
          throw new Error(`Hemmings (страница ${page}) ответил ${more.status}`);
        const moreData = await more.json();
        items.push(...(moreData.results || []));
      }
    }

    /*
     * adtype=cars-for-sale не отсекает автомобилию внутри аукционов —
     * таблички дилеров, неоновые вывески, часы идут тем же списком, с
     * тем же полем "make" (маркой автопроизводителя, которого там и в
     * помине нет под капотом). У них единообразно model.slug === "other"
     * и нет настоящей модели — у настоящих машин модель есть всегда.
     */
    return items.filter(item => item.model?.slug !== "other");
  }

  /*
   * Выдача listing_status[]=sold идёт от свежих продаж к старым (sort_by
   * API игнорирует, порядок один и тот же). Поэтому листаем, пока на
   * странице есть хоть один лот, которого ещё нет в архиве — как только
   * страница целиком уже знакомая, дальше идти незачем.
   */
  async fetchSoldPage(page, transmission = null) {
    const params = new URLSearchParams({
      adtype: "cars-for-sale",
      "listing_type[]": "hemmings_auctions_only",
      "listing_status[]": "sold",
      distance: "50",
      page: String(page),
      per_page: String(SOLD_PER_PAGE),
      members_preview: "false",
    });
    if (transmission)
      params.set("transmission_type[]", transmission);

    const response = await this.fetchImpl(`${LISTINGS_URL}?${params}`, { headers: HEMMINGS_HEADERS });

    if (!response.ok)
      throw new Error(`Hemmings (проданные, страница ${page}) ответил ${response.status}`);

    const data = await response.json();
    return data.results || [];
  }

  /*
   * В карточке выдачи Hemmings нет ни пробега, ни цвета, ни коробки (они
   * только на странице лота, закрытой Cloudflare), но у поиска есть
   * фильтр transmission_type — спрашиваем отдельно «только механика» и
   * «только автомат» и по этим спискам помечаем лоты. API называет
   * автомат значением "auto". Лоты, не попавшие ни в тот, ни в другой
   * список (у них коробка не указана), остаются без отметки.
   */
  async fetchTransmissionIds(maxPages) {
    const kinds = new Map();

    for (const [filter, kind] of [["manual", "manual"], ["auto", "automatic"]]) {
      for (let page = 1; page <= maxPages; page += 1) {
        const items = await this.fetchSoldPage(page, filter);
        for (const item of items)
          kinds.set(`hemmings-${item.id}`, kind);
        if (items.length < SOLD_PER_PAGE)
          break;
      }
    }

    return kinds;
  }

  async updateSoldArchive({ maxPages = SOLD_MAX_PAGES, stopWhenKnown = true } = {}) {
    const archive = loadSoldArchive(this.soldFile());
    let added = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      const items = await this.fetchSoldPage(page);
      let newOnPage = 0;

      for (const item of items) {
        if (item.model?.slug === "other") // таблички/вывески/часы — см. fetchActiveListings
          continue;
        const soldLot = toSoldLot(item);
        if (typeof soldLot.salePrice !== "number")
          continue;
        if (!archive[soldLot.id]) {
          archive[soldLot.id] = soldLot;
          newOnPage += 1;
        }
      }

      added += newOnPage;

      if (items.length < SOLD_PER_PAGE || (stopWhenKnown && newOnPage === 0))
        break;
    }

    // Коробка: новые лоты — по самым свежим страницам фильтров; при разовом добавлении истории — по всей глубине.
    let marked = 0;
    const kinds = await this.fetchTransmissionIds(stopWhenKnown ? 2 : maxPages);
    for (const lot of Object.values(archive)) {
      const kind = kinds.get(lot.id);
      if (kind && lot.transmissionKind !== kind) {
        lot.transmissionKind = kind;
        lot.transmission = kind === "manual" ? "Механика" : "Автомат";
        marked += 1;
      }
    }

    if (added > 0 || marked > 0) {
      saveSoldArchive(this.soldFile(), archive);
      this.log(`BRONVERA Rare: добавил ${added} проданных лотов Hemmings в архив (всего ${Object.keys(archive).length})`);
    }

    return added;
  }

  async run() {
    const now = this.now();
    const previousIds = new Set(this.readLots().lots.map(lot => lot.id));

    try {
      const items = await this.fetchActiveListings();
      const lots = items.map(item => toRareLot(item, now));

      this.log(`BRONVERA Rare: собрано ${lots.length} лотов с Hemmings`);

      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.lotsFile(),
        JSON.stringify({ updatedAt: new Date(now).toISOString(), source: "Hemmings", count: lots.length, lots }, null, 2),
      );

      this.writeStatus({ source: "Hemmings", lastRunAt: new Date(now).toISOString(), ok: true, count: lots.length, error: null });

      if (!soldArchiveLocked(this.dataDir))
        await this.updateSoldArchive().catch(error => this.log("BRONVERA Rare: не добрал архив продаж Hemmings:", error.message));

      if (this.alerts) {
        const newLots = lots.filter(lot => !previousIds.has(lot.id));
        const allLotsById = new Map(lots.map(lot => [lot.id, lot]));
        await this.alerts.checkAfterRun({ newLots, allLotsById }).catch(error => this.log("BRONVERA Rare: ошибка алертов (Hemmings):", error.message));
      }

      return lots;
    }
    catch (error) {
      this.writeStatus({ source: "Hemmings", lastRunAt: new Date(now).toISOString(), ok: false, count: null, error: error.message });
      throw error;
    }
  }

  start(intervalMs = 24 * 3600 * 1000) {
    if (this.timer)
      return;

    const tick = () => this.run().catch(error => console.error("HemmingsScraper error:", error.message));

    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = HemmingsScraper;
