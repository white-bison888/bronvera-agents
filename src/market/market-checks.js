const fs = require("fs");
const path = require("path");
const defaultHistory = require("../history/store");
const { marketSnapshot } = require("./minsk-prices");

/*
 * СВЕРКА ЦЕНЫ В БЕЛАРУСИ
 *
 * Продаж в Беларуси через систему нет, поэтому прогноз цены проверяется
 * повторным сбором рынка: через 7 дней после прогноза и дальше каждую
 * неделю те же площадки опрашиваются заново, а разница с прогнозом и
 * объявления каждой сверки сохраняются (решение Mikita 2026-09-15).
 *
 * Сверяется прогноз, который действует сейчас, — последняя оценка лота
 * с ценой в Беларуси. Пересчёт после фото ту же цену не меняет и сверки
 * не сбрасывает; новая цена — новый прогноз и сверки с нуля, прежние
 * остаются в архиве.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 7 * DAY_MS;

// Четыре недели показывают, куда идёт рынок; дальше сверять один прогноз незачем.
const MAX_CHECKS = 4;

const TICK_MS = 60 * 60 * 1000;

// По одному лоту с паузой: площадкам незачем видеть от нас пачку запросов.
const PER_TICK = 10;
const PAUSE_MS = 3000;

const pct = (value, base) => Math.round(((value - base) / base) * 1000) / 10;

class MarketChecker {
  constructor({ marketPrices, bidCars, history = defaultHistory, file, now, sleep, options = {} }) {
    this.marketPrices = marketPrices;
    this.bidCars = bidCars;
    this.history = history;
    this.file = file || path.join(process.cwd(), "data", "market-checks.json");
    this.now = now || (() => Date.now());
    this.sleep = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.tickMs = options.tickMs || TICK_MS;
    this.timer = null;
    this.running = false;
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return parsed && parsed.lots ? parsed : { lots: {} };
    } catch {
      return { lots: {} };
    }
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  /*
   * Действующий прогноз цены по каждому лоту. Начало прогноза — когда
   * собраны объявления, а без снимка — первая оценка подряд с этой ценой.
   */
  forecasts() {
    const byLot = new Map();

    for (const entry of this.history.readAll()) {
      const lot = String(entry.lotNumber);
      byLot.set(lot, [...(byLot.get(lot) || []), entry]);
    }

    const result = [];

    for (const [lotNumber, entries] of byLot) {
      const priced = entries
        .filter(entry => Number.isFinite(entry.marketValueUsd))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

      if (!priced.length)
        continue;

      const latest = priced[priced.length - 1];
      let first = latest;

      for (let i = priced.length - 1; i >= 0 && priced[i].marketValueUsd === latest.marketValueUsd; i--)
        first = priced[i];

      result.push({
        lotNumber,
        entry: latest,
        valueUsd: latest.marketValueUsd,
        since: latest.market?.fetchedAt || first.createdAt,
      });
    }

    return result;
  }

  // Запись сверок под действующий прогноз; прежний прогноз уходит в архив.
  recordFor(state, forecast) {
    const current = state.lots[forecast.lotNumber];

    if (current && current.forecastAt === forecast.since && current.forecastValueUsd === forecast.valueUsd)
      return current;

    const record = {
      forecastAt: forecast.since,
      forecastValueUsd: forecast.valueUsd,
      checks: [],
      archived: current
        ? [...(current.archived || []), { forecastAt: current.forecastAt, forecastValueUsd: current.forecastValueUsd, checks: current.checks }]
        : [],
    };

    state.lots[forecast.lotNumber] = record;
    return record;
  }

  nextAt(record) {
    if (record.checks.length >= MAX_CHECKS)
      return null;

    const last = record.checks.length ? record.checks[record.checks.length - 1].at : record.forecastAt;
    return new Date(Date.parse(last) + CHECK_EVERY_MS).toISOString();
  }

  async runDue() {
    const state = this.read();
    const now = this.now();

    const due = this.forecasts()
      .map(forecast => ({ forecast, record: this.recordFor(state, forecast) }))
      .filter(({ record }) => {
        const next = this.nextAt(record);
        return next !== null && Date.parse(next) <= now;
      })
      .sort((a, b) => Date.parse(this.nextAt(a.record)) - Date.parse(this.nextAt(b.record)))
      .slice(0, PER_TICK);

    // Архив и новые прогнозы сохраняем, даже если сверять сейчас нечего.
    this.write(state);

    const done = [];

    for (const [index, { forecast, record }] of due.entries()) {
      if (index)
        await this.sleep(PAUSE_MS);

      const listing = this.bidCars?.findByLotNumber?.(forecast.lotNumber) || {};
      const result = await this.marketPrices.lookup({
        lotNumber: forecast.lotNumber,
        make: forecast.entry.make ?? listing.make,
        model: forecast.entry.model ?? listing.model,
        year: forecast.entry.year ?? listing.year,
        mileage: listing.mileage ?? forecast.entry.mileage,
      });

      // Площадка не ответила — это не итог сверки, попробуем в следующий час.
      if (result.status === "source_error")
        continue;

      const value = Number.isFinite(result.marketValueUsd) ? result.marketValueUsd : null;

      record.checks.push({
        at: new Date(this.now()).toISOString(),
        status: result.status,
        marketValueUsd: value,
        diffUsd: value === null ? null : value - record.forecastValueUsd,
        diffPct: value === null ? null : pct(value, record.forecastValueUsd),
        reason: result.reason || null,
        market: marketSnapshot(result),
      });

      this.write(state);
      done.push(forecast.lotNumber);
    }

    return done;
  }

  // Файл сверок вместе с прогнозами, которые ещё ни разу не сверялись: у них уже есть дата.
  current() {
    const state = this.read();

    for (const forecast of this.forecasts())
      this.recordFor(state, forecast);

    return state;
  }

  // Для списков: без объявлений, только цифры сверок.
  summary() {
    const lots = {};

    for (const [lotNumber, record] of Object.entries(this.current().lots)) {
      lots[lotNumber] = {
        forecastAt: record.forecastAt,
        forecastValueUsd: record.forecastValueUsd,
        nextAt: this.nextAt(record),
        checks: record.checks.map(({ market, ...check }) => ({
          ...check,
          analogsCount: market?.analogsCount ?? null,
        })),
      };
    }

    return lots;
  }

  detail(lotNumber) {
    const record = this.current().lots[String(lotNumber)];
    return record ? { ...record, nextAt: this.nextAt(record) } : null;
  }

  start() {
    if (this.timer)
      return;

    console.log("🇧🇾 Сверка цены в Беларуси запущена: раз в 7 дней после прогноза");

    const tick = async () => {
      if (this.running)
        return;

      this.running = true;

      try {
        const done = await this.runDue();
        if (done.length)
          console.log(`🇧🇾 Сверка цены в Беларуси: ${done.join(", ")}`);
      } catch (error) {
        console.error("Сверка цены в Беларуси:", error.message);
      } finally {
        this.running = false;
      }
    };

    this.timer = setInterval(tick, this.tickMs);
    setTimeout(tick, 120000);
  }
}

module.exports = { MarketChecker, CHECK_EVERY_MS, MAX_CHECKS };
