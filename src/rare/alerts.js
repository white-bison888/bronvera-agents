const fs = require("fs");
const path = require("path");

/*
 * BRONVERA Rare, Фаза 2 (01.10.2026): алерты в Telegram. Один получатель —
 * Mikita (TELEGRAM_CHAT_ID в .env), без регистрации и аккаунтов. Решения
 * из интервью: канал Telegram, два источника событий:
 * 1. Сохранённые критерии поиска — сверяются с НОВЫМИ лотами (которых не
 *    было в прошлом суточном прогоне), не со всем списком каждый раз —
 *    иначе один и тот же подходящий лот слал бы алерт каждый день.
 * 2. Конкретные лоты на «Следить за лотом» (кнопка на сайте) — сверяются
 *    на смену ставки или статуса торгов.
 *
 * Критерий — ключевые слова (каждое должно встретиться в марке, модели
 * или заголовке лота), не структурированный марка+модель: точного кода
 * шасси вроде «E30» в заголовках BaT часто просто нет (см. находку в
 * bat-scraper.js), так что жёсткий выбор из списка моделей обманул бы
 * пользователя пустыми совпадениями.
 */

const sendTelegramMessage = async (text, { fetchImpl = fetch } = {}) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("BRONVERA Rare: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не настроены — алерт не отправлен:", text);
    return false;
  }

  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
  });

  if (!response.ok)
    console.error("BRONVERA Rare: Telegram ответил", response.status, await response.text().catch(() => ""));

  return response.ok;
};

const STATUS_LABELS = { open: "открытые торги", closing: "скоро закрываются", ended: "торги завершены" };

const formatBid = value => (typeof value === "number" ? `$${Math.round(value).toLocaleString("ru-RU")}` : null);

class RareAlerts {
  constructor({
    dataDir = path.join(process.cwd(), "data", "rare"),
    log = (...args) => console.log(...args),
    send = sendTelegramMessage,
  } = {}) {
    Object.assign(this, { dataDir, log, send });
  }

  watchlistFile() {
    return path.join(this.dataDir, "watchlist.json");
  }

  watchedLotsFile() {
    return path.join(this.dataDir, "watched-lots.json");
  }

  readWatchlist() {
    try {
      return JSON.parse(fs.readFileSync(this.watchlistFile(), "utf8"));
    }
    catch {
      return [];
    }
  }

  writeWatchlist(list) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.watchlistFile(), JSON.stringify(list, null, 2));
  }

  addWatchlistItem({ keyword, budgetMax }) {
    const trimmed = String(keyword || "").trim();
    if (!trimmed)
      throw new Error("Пустой запрос — нечего искать");

    const list = this.readWatchlist();
    const item = {
      id: `w${Date.now()}${Math.floor(Math.random() * 1000)}`,
      keyword: trimmed,
      budgetMax: Number.isFinite(Number(budgetMax)) && budgetMax !== null && budgetMax !== "" ? Number(budgetMax) : null,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    list.push(item);
    this.writeWatchlist(list);
    return item;
  }

  removeWatchlistItem(id) {
    const list = this.readWatchlist().filter(item => item.id !== id);
    this.writeWatchlist(list);
    return list;
  }

  /*
   * Редактирование на месте (слова, бюджет) и переключатель включено/
   * выключено — решение Mikita 01.10.2026: критерий на паузе не теряется,
   * просто не проверяется в checkAfterRun, пока снова не включат.
   */
  updateWatchlistItem(id, { keyword, budgetMax, enabled } = {}) {
    const list = this.readWatchlist();
    const item = list.find(entry => entry.id === id);
    if (!item)
      throw new Error("Критерий не найден — возможно, уже удалён");

    if (keyword !== undefined) {
      const trimmed = String(keyword).trim();
      if (!trimmed)
        throw new Error("Пустой запрос — нечего искать");
      item.keyword = trimmed;
    }
    if (budgetMax !== undefined)
      item.budgetMax = Number.isFinite(Number(budgetMax)) && budgetMax !== null && budgetMax !== "" ? Number(budgetMax) : null;
    if (enabled !== undefined)
      item.enabled = Boolean(enabled);

    this.writeWatchlist(list);
    return item;
  }

  readWatchedLots() {
    try {
      return JSON.parse(fs.readFileSync(this.watchedLotsFile(), "utf8"));
    }
    catch {
      return {};
    }
  }

  writeWatchedLots(map) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.watchedLotsFile(), JSON.stringify(map, null, 2));
  }

  setLotWatch(lotId, watched, lot) {
    const map = this.readWatchedLots();

    if (watched) {
      map[lotId] = {
        addedAt: map[lotId]?.addedAt || new Date().toISOString(),
        lastBid: lot?.currentBid ?? null,
        lastStatus: lot?.status ?? null,
      };
    }
    else {
      delete map[lotId];
    }

    this.writeWatchedLots(map);
    return map;
  }

  /* Каждое слово критерия должно встретиться где-то в марке, модели или заголовке. */
  matchesKeyword(lot, keyword) {
    const haystack = `${lot.make} ${lot.model || ""} ${lot.title}`.toLowerCase();
    const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every(word => haystack.includes(word));
  }

  /*
   * Вызывается из BatScraper.run() после каждого суточного обновления.
   * newLots — лоты, которых не было в прошлом прогоне. allLotsById — карта
   * текущих лотов по id, для сверки «Следить».
   */
  async checkAfterRun({ newLots, allLotsById }) {
    const watchlist = this.readWatchlist();

    for (const lot of newLots) {
      for (const criterion of watchlist) {
        // enabled !== false — старые записи без этого поля (до 01.10.2026) считаются включёнными.
        if (criterion.enabled === false)
          continue;
        if (!this.matchesKeyword(lot, criterion.keyword))
          continue;
        if (criterion.budgetMax !== null && lot.currentBid !== null && lot.currentBid > criterion.budgetMax)
          continue;

        await this.send(
          `🔔 Новый лот под критерий «${criterion.keyword}»\n${lot.title}\n`
          + `${formatBid(lot.currentBid) ? `Ставка: ${formatBid(lot.currentBid)}` : "Ставок пока нет"}\n`
          + `${lot.sourceUrl}`,
        );
      }
    }

    const watchedLots = this.readWatchedLots();
    let changed = false;

    for (const [lotId, known] of Object.entries(watchedLots)) {
      const lot = allLotsById.get(lotId);
      if (!lot)
        continue;

      if (lot.currentBid !== known.lastBid && lot.currentBid !== null) {
        await this.send(`💰 Новая ставка на лоте, за которым вы следите\n${lot.title}\n${formatBid(lot.currentBid)}\n${lot.sourceUrl}`);
        known.lastBid = lot.currentBid;
        changed = true;
      }

      if (lot.status !== known.lastStatus) {
        await this.send(`⏱ Статус изменился: ${STATUS_LABELS[lot.status] || lot.status}\n${lot.title}\n${lot.sourceUrl}`);
        known.lastStatus = lot.status;
        changed = true;
      }
    }

    if (changed)
      this.writeWatchedLots(watchedLots);
  }
}

module.exports = RareAlerts;
