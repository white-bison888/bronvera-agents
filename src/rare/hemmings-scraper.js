const fs = require("fs");
const path = require("path");

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
    status: statusOf(closesAt, now),
    photoUrl: item.thumbnail?.md?.["4:3"] || item.thumbnail?.md?.full || null,
  };
};

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

    return items;
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
