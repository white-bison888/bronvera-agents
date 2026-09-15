const fs = require("fs");
const path = require("path");

const defaultConfig = require("./config");
const defaultHistory = require("../history/store");
const defaultQueue = require("../photos/queue");
const { calculateMaxBid } = require("../economics/max-bid");
const { fetchSearchSlice, mapSearchItem } = require("../providers/bidcars-search-api");
const {
  countBy,
  evaluateLot,
  minskDay,
  minskHour,
  prefilterReason,
  rankTiers,
} = require("./select");

const BUCKET_KEY = "make:tesla";
const HOUR_MS = 3600000;

const randomBetween = ([min, max]) => min + Math.floor(Math.random() * (max - min + 1));

/*
 * Утренний отбор. Один прогон — один файл дня в data/screener: что
 * просмотрели, почему отсеяли, кто попал в списки. По этим файлам и
 * финалам торгов в истории делается пересмотр пилота.
 */
class DailyScreener {
  constructor({
    bidCars,
    marketPrices,
    photoAssessor,
    photoCollector = null,
    history = defaultHistory,
    photoQueue = defaultQueue,
    fetchSlice = fetchSearchSlice,
    config = defaultConfig,
    dataDir = path.join(process.cwd(), "data", "screener"),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    log = (...args) => console.log(...args),
  }) {
    Object.assign(this, {
      bidCars, marketPrices, photoAssessor, photoCollector, history, photoQueue,
      fetchSlice, config, dataDir, sleep, log,
    });

    this.running = null;
    this.timer = null;
  }

  dayFile(day) {
    return path.join(this.dataDir, `${day}.json`);
  }

  readDay(day) {
    try {
      return JSON.parse(fs.readFileSync(this.dayFile(day), "utf8"));
    } catch {
      return null;
    }
  }

  writeDay(day, state) {
    fs.mkdirSync(this.dataDir, { recursive: true });

    const file = this.dayFile(day);

    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(`${file}.tmp`, file);
  }

  latestDay(now = new Date()) {
    const today = minskDay(now);

    try {
      const days = fs.readdirSync(this.dataDir)
        .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .map(name => name.slice(0, 10))
        .filter(day => day <= today)
        .sort();

      return days.length ? this.readDay(days[days.length - 1]) : null;
    } catch {
      return null;
    }
  }

  isPilotDay(day) {
    return day >= this.config.pilotFrom && day <= this.config.pilotUntil;
  }

  /*
   * Запуск по расписанию: день пилота, утро по Минску наступило, а
   * сегодняшний скан не сделан. Упавший повторяем через полчаса, не больше
   * трёх раз. «Идёт» дольше двух часов означает перезапуск сервера посреди
   * скана — начинаем заново.
   */
  shouldRun(now = new Date()) {
    const day = minskDay(now);

    if (!this.isPilotDay(day) || minskHour(now) < this.config.runAtMinskHour || this.running)
      return false;

    const state = this.readDay(day);

    if (!state)
      return true;

    if ((state.attempts || 0) >= this.config.maxAttemptsPerDay)
      return false;

    const since = now.getTime() - new Date(state.startedAt || 0).getTime();

    if (state.status === "failed")
      return since >= 0.5 * HOUR_MS;

    if (state.status === "running")
      return since >= 2 * HOUR_MS;

    return false;
  }

  start() {
    if (this.timer)
      return;

    const day = minskDay(new Date());

    if (day > this.config.pilotUntil) {
      this.log(`🗓️ Пилот ежедневного отбора завершён ${this.config.pilotUntil}, расписание не запускается`);
      return;
    }

    this.log(
      `🗓️ Ежедневный отбор: пилот ${this.config.pilotFrom}…${this.config.pilotUntil}, ` +
      `скан после ${this.config.runAtMinskHour}:00 по Минску`
    );

    const check = () => {
      if (minskDay(new Date()) > this.config.pilotUntil) {
        this.stop();
        this.log("🗓️ Пилот ежедневного отбора завершён — расписание остановлено");
        return;
      }

      if (this.shouldRun())
        this.run().catch(error => this.log(`🗓️ Отбор не удался: ${error.message}`));
    };

    this.timer = setInterval(check, this.config.checkEveryMs);
    this.firstCheck = setTimeout(check, 60000);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.firstCheck);
    this.timer = null;
  }

  run(options = {}) {
    if (this.running)
      return this.running;

    this.running = this.execute(options).finally(() => {
      this.running = null;
    });

    return this.running;
  }

  async execute({ now = () => new Date() } = {}) {
    const startedAt = now();
    const day = minskDay(startedAt);
    const previous = this.readDay(day);

    const state = {
      day,
      pilot: {
        from: this.config.pilotFrom,
        until: this.config.pilotUntil,
        reviewOn: this.config.reviewOn,
      },
      status: "running",
      attempts: (previous?.attempts || 0) + 1,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      slices: [],
    };

    this.writeDay(day, state);
    this.log(`\n🗓️ ЕЖЕДНЕВНЫЙ ОТБОР ${day}, попытка ${state.attempts}`);

    try {
      state.slices = await this.scanCatalog(now);

      if (!state.slices.some(slice => slice.status === "ok"))
        throw new Error("bid.cars не отдал ни одной части каталога");

      Object.assign(state, await this.select(now()));

      state.status = "done";
    } catch (error) {
      state.status = "failed";
      state.error = error.message;
    }

    state.finishedAt = now().toISOString();
    this.writeDay(day, state);

    this.log(
      state.status === "done"
        ? `🗓️ Отбор ${day} готов: ` +
          state.tiers.map(tier => `${tier.label} — ${tier.candidates.length}`).join(", ") +
          `, на фото ${state.photoQueued}`
        : `🗓️ Отбор ${day} не удался: ${state.error}`
    );

    return state;
  }

  /*
   * Части каталога по очереди, с паузами. Каждую удачную сразу пишем
   * в реестр: упади скан на пятой части, первые четыре не пропадут.
   */
  async scanCatalog(now) {
    const pending = this.config.slices.map(slice => ({ slice, attempts: 0 }));
    let requests = 0;

    for (let round = 0; round < this.config.sliceAttempts && pending.some(p => !p.done); round += 1) {
      if (round > 0)
        await this.sleep(randomBetween(this.config.retryPauseMs));

      for (const item of pending.filter(p => !p.done)) {
        if (requests > 0)
          await this.sleep(randomBetween(this.config.slicePauseMs));

        requests += 1;
        item.attempts += 1;

        const url = this.bidCars.buildCatalogUrl(BUCKET_KEY, 1, {
          make: this.config.make,
          models: item.slice.models,
          yearFrom: item.slice.yearFrom,
          yearTo: item.slice.yearTo,
        });

        try {
          const fetchedAt = now();
          const page = await this.fetchSlice(url);

          const listings = page.items
            .map(entry => mapSearchItem(entry, { fetchedAt, make: this.config.make }))
            .filter(Boolean);

          this.saveToRegistry(listings, fetchedAt);

          const saleDates = listings.map(lot => lot.saleDate).filter(Boolean).sort();

          item.done = true;
          item.result = {
            label: item.slice.label,
            status: "ok",
            attempts: item.attempts,
            lots: listings.length,
            activeInCatalog: page.activeCount,
            // Выдача обрезана на 50: последняя дата — докуда хватило покрытия.
            truncated: page.hasMore,
            coveredUntil: page.hasMore ? saleDates[saleDates.length - 1] || null : null,
          };

          this.log(
            `   ${item.slice.label}: ${listings.length} лотов из ${page.activeCount ?? "?"}` +
            (page.hasMore ? `, покрыто до ${item.result.coveredUntil}` : "")
          );
        } catch (error) {
          item.result = {
            label: item.slice.label,
            status: "failed",
            attempts: item.attempts,
            error: error.message,
          };

          this.log(`   ${item.slice.label}: ${error.message}`);
        }
      }
    }

    return pending.map(item => item.result);
  }

  /*
   * Список дня с тем, что стало с кандидатами после отбора: разобраны ли
   * фото, какой вердикт вынесла формула, чем закончились торги.
   */
  withLiveState(state) {
    if (!state || !Array.isArray(state.tiers))
      return state;

    const latest = new Map();

    for (const record of this.history.readAll()) {
      const key = String(record.lotNumber);
      const current = latest.get(key);

      if (!current || (record.createdAt || "") >= (current.createdAt || ""))
        latest.set(key, record);
    }

    let queued = [];

    try {
      queued = this.photoQueue.read().items;
    } catch {
      // Очередь недоступна — покажем список без её состояния.
    }

    const live = (lotNumber) => {
      const record = latest.get(String(lotNumber));
      const task = queued.find(item => String(item.lotNumber) === String(lotNumber));

      return {
        decision: record?.decision || null,
        maxBidUsd: record?.maxBidUsd ?? null,
        profit: record?.profit || null,
        verdictReason: record?.verdictReason || null,
        repairCostUsd: record?.repairCostUsd ?? null,
        repairCostSource: record?.repairCostSource || null,
        photosAnalyzed: record?.photosAnalyzed ?? null,
        photoQueue: task ? { status: task.status, attempts: task.attempts, lastError: task.lastError } : null,
        actual: record?.actual || null,
      };
    };

    return {
      ...state,
      tiers: state.tiers.map(tier => ({
        ...tier,
        candidates: tier.candidates.map(candidate => ({ ...candidate, now: live(candidate.lotNumber) })),
      })),
    };
  }

  saveToRegistry(listings, fetchedAt) {
    const cache = this.bidCars.loadCache();
    const bucket = this.bidCars.getBucket(cache, BUCKET_KEY);

    bucket.vehicles = this.bidCars.mergeVehicles(bucket.vehicles, listings, fetchedAt.toISOString());
    cache.buckets[BUCKET_KEY] = bucket;

    this.bidCars.saveCache(cache);
  }

  /*
   * Кандидаты — открытые лоты реестра, которые видели в последние сутки
   * с небольшим: свежий скан плюс то, что не удалось обновить сегодня.
   */
  poolFromRegistry(now) {
    const cache = this.bidCars.loadCache();
    const vehicles = cache.buckets?.[BUCKET_KEY]?.vehicles || [];
    const since = now.getTime() - this.config.poolMaxAgeHours * HOUR_MS;

    return vehicles.filter(lot => lot.lotNumber
      && new Date(lot.lastSeenAt || lot.sourceFetchedAt || 0).getTime() >= since);
  }

  async select(now) {
    const pool = this.poolFromRegistry(now);
    const excluded = [];
    const passed = [];

    for (const lot of pool) {
      const reason = prefilterReason(lot, { now, config: this.config });

      if (reason)
        excluded.push(reason);
      else
        passed.push(lot);
    }

    const evaluated = [];

    // По одному: площадкам объявлений незачем видеть пачку запросов разом.
    for (const lot of passed) {
      const market = await this.marketPrices.lookup({
        lotNumber: lot.lotNumber,
        make: lot.make,
        model: lot.model,
        year: lot.year,
        mileage: lot.mileage,
      });

      if (!market.marketValueUsd) {
        excluded.push("нет цены в Беларуси");
        continue;
      }

      const photoAssessment = this.photoAssessor?.getCached?.(lot.lotNumber) || null;
      const evaluation = evaluateLot(lot, { market, photoAssessment });

      if (evaluation.repairRoomUsd === null) {
        excluded.push("сделку не посчитать");
        continue;
      }

      if (evaluation.result.verdict === "SKIP" && evaluation.result.maxBidUsd === null) {
        excluded.push("продавец не страховая");
        continue;
      }

      evaluated.push({ lot, market, photoAssessment, ...evaluation });
    }

    const tiers = rankTiers(evaluated, this.config);

    excluded.push(...evaluated
      .filter(item => item.repairRoomUsd < this.config.minRepairRoomUsd)
      .map(() => "мал запас на ремонт"));

    const chosen = new Map();

    for (const tier of tiers) {
      for (const item of tier.candidates) {
        const entry = chosen.get(item.lot.lotNumber) || { ...item, tiers: {} };

        entry.tiers[tier.id] = item.rank;
        chosen.set(item.lot.lotNumber, entry);
      }
    }

    const photosFromListing = await this.downloadPhotos([...chosen.values()]);
    const photoQueued = this.handOver([...chosen.values()], now);

    return {
      scanned: pool.length,
      passedPrefilter: passed.length,
      priced: evaluated.length,
      excluded: countBy(excluded),
      photosFromListing,
      photoQueued,
      tiers: tiers.map(tier => ({
        id: tier.id,
        label: tier.label,
        maxExpectedPriceUsd: tier.maxExpectedPriceUsd,
        candidates: tier.candidates.map(item => this.describe(item, chosen.get(item.lot.lotNumber))),
      })),
    };
  }

  /*
   * Кадры кандидатов — сразу, по ссылкам из выдачи. Очередь потом найдёт
   * их на диске и перейдёт к разбору, не заходя на закрытые страницы лотов.
   * Сбой здесь не роняет отбор: недостающее соберёт очередь.
   */
  async downloadPhotos(entries) {
    const lots = entries.filter(entry => !entry.photoAssessment).map(entry => entry.lot);

    if (!this.photoCollector?.collectFromListing || lots.length === 0)
      return 0;

    try {
      const saved = await this.photoCollector.collectFromListing(lots);

      return Object.values(saved).filter(files => files.length > 0).length;
    } catch (error) {
      this.log(`   кадры по ссылкам из выдачи не скачались: ${error.message}`);

      return 0;
    }
  }

  describe(item, entry) {
    const { lot, market, result } = item;

    return {
      rank: item.rank,
      lotNumber: lot.lotNumber,
      url: lot.url,
      vehicle: [lot.year, lot.make, lot.model].filter(Boolean).join(" "),
      year: lot.year,
      model: lot.model,
      mileageMi: lot.mileage ?? null,
      primaryDamage: lot.primaryDamage || null,
      secondaryDamage: lot.secondaryDamage || null,
      seller: lot.seller || null,
      titleType: lot.titleType || null,
      location: lot.location || null,
      saleDate: lot.saleDate || null,
      currentBidUsd: lot.currentBid ?? null,
      forecast: result.forecast,
      expectedPriceUsd: item.expectedPriceUsd,
      marketValueUsd: market.marketValueUsd,
      marketAnalogs: market.analogsCount ?? null,
      marketLevel: market.match?.level || null,
      marketUnderestimated: market.match?.underestimated === true,
      priceToMarketPct: item.priceToMarketPct,
      repairCostUsd: item.repairCostUsd,
      repairSource: item.repairSource,
      damageType: item.damageType || null,
      repairRoomUsd: item.repairRoomUsd,
      profitAtExpectedUsd: item.profitAtExpectedUsd,
      maxBidWithoutPhotosUsd: result.maxBidUsd,
      vatExempt: result.assumptions?.vatExempt ?? null,
      ageYears: result.assumptions?.ageYears ?? null,
      inTiers: entry ? entry.tiers : {},
      photoStatus: item.photoAssessment ? "assessed" : "queued",
    };
  }

  /*
   * Кандидаты уходят в обычный путь лота: запись в истории (без неё сбор
   * фото не пересчитает ставку) и очередь фотографий. Ближайшие торги —
   * первыми в очереди. Лот, уже оценённый сегодня, повторно не пишем.
   */
  handOver(entries, now) {
    const day = minskDay(now);
    const history = this.history.readAll();

    const ordered = [...entries].sort((a, b) =>
      String(a.lot.saleDate || "").localeCompare(String(b.lot.saleDate || "")));

    const records = [];
    const toQueue = [];

    for (const entry of ordered) {
      const { lot, market, photoAssessment } = entry;
      const lotNumber = String(lot.lotNumber);

      const recent = history.some(record => String(record.lotNumber) === lotNumber
        && record.screener?.day === day);

      if (!photoAssessment)
        toQueue.push({ lotNumber });

      if (recent)
        continue;

      const result = calculateMaxBid({
        ...lot,
        marketValueUsd: market.marketValueUsd,
        ...(photoAssessment ? { photoAssessment } : {}),
      });

      records.push({
        lotNumber,
        vin: lot.vin || null,
        make: lot.make || null,
        model: lot.model || null,
        year: lot.year || null,
        url: lot.url || null,
        primaryDamage: lot.primaryDamage || null,
        saleDate: lot.saleDate || null,
        bidAtAnalysisUsd: lot.currentBid ?? null,
        marketValueUsd: market.marketValueUsd,
        repairCostUsd: result.breakdown?.repairCostUsd ?? null,
        repairCostSource: result.repairCostSource || null,
        damageType: result.damageType || null,
        maxBidUsd: result.maxBidUsd ?? null,
        viable: result.viable === true,
        forecast: result.forecast || entry.result.forecast || null,
        profit: result.profit || null,
        verdictReason: result.reason || null,
        breakdown: result.breakdown || null,
        assumptions: result.assumptions || null,
        notViableReason: result.viable === false ? result.reason : null,
        photoStatus: result.photoStatus || null,
        photosAnalyzed: result.photosAnalyzed ?? null,
        decision: result.verdict || null,
        decisionHeld: null,
        screener: {
          day,
          tiers: entry.tiers,
          expectedPriceUsd: entry.expectedPriceUsd,
          repairRoomUsd: entry.repairRoomUsd,
          profitWithoutPhotosUsd: entry.profitAtExpectedUsd,
        },
      });
    }

    if (records.length)
      this.history.appendRun(records);

    return toQueue.length ? this.photoQueue.enqueue(toQueue, `screener-${day}`) : 0;
  }
}

module.exports = DailyScreener;
