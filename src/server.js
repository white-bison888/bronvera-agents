require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const sharp = require("sharp");

const BidCarsProvider = require("./providers/bidcars");
const { calculateMaxBid } = require("./economics/max-bid");
const { describeDamage } = require("./providers/damage-labels");
const history = require("./history/store");
const LotPhotoCollector = require("./providers/lot-photos");
const PhotoAssessor = require("./vision/photo-assessor");
const photoQueue = require("./photos/queue");
const PhotoWorker = require("./photos/worker");
const BidWatcher = require("./photos/bid-watcher");
const { MinskMarketPrices } = require("./market/minsk-prices");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const bidCars = new BidCarsProvider();
const photoCollector = new LotPhotoCollector();
const photoAssessor = new PhotoAssessor();
const marketPrices = new MinskMarketPrices();

const photoWorker = new PhotoWorker({
  bidCars,
  photoCollector,
  photoAssessor,
});

const bidWatcher = new BidWatcher({ bidCars });

/*
 * Последний поиск помним, чтобы интерфейс мог показать покрытие
 * фотографиями по текущему запросу, не зная сам о его критериях —
 * их разбирает Dify, а не фронтенд.
 */
let lastSearch = null;

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "bronvera-api",
  });
});

app.post("/api/cars/search", async (req, res) => {
  try {
    const {
      make = null,
      models = [],

      yearFrom = null,
      yearTo = null,

      mileageMin = null,
      mileageMax = null,

      fuelTypes = [],
      bodyStyles = [],
      driveTypes = [],
      transmissions = [],

      startCodes = [],
      auctionTypes = [],
      exteriorColors = [],

      maxResults = 20,
      maxPages = 2,
    } = req.body || {};

    console.log("\n🚘 Search request:");

    console.log({
      make,
      models,

      yearFrom,
      yearTo,

      mileageMin,
      mileageMax,

      fuelTypes,
      bodyStyles,
      driveTypes,
      transmissions,

      startCodes,
      auctionTypes,
      exteriorColors,

      maxResults,
      maxPages,
    });

    const result = await bidCars.searchCars({
      make,
      models,

      yearFrom,
      yearTo,

      mileageMin,
      mileageMax,

      fuelTypes,
      bodyStyles,
      driveTypes,
      transmissions,

      startCodes,
      auctionTypes,
      exteriorColors,

      maxResults,
      maxPages,
    });

    lastSearch = {
      filters: { make, models, yearFrom, yearTo, mileageMin, mileageMax,
        fuelTypes, bodyStyles, driveTypes, transmissions, startCodes, auctionTypes },
      found: Array.isArray(result.listings) ? result.listings.length : 0,
      // Сколько лотов вообще просмотрели и сколько отсеяли обязательные
      // требования — без этих чисел короткая выдача выглядит как сбой.
      requirements: bidCars.lastRequirementStats || null,
      at: new Date().toISOString(),
    };

    res.json({
      success: true,

      count: Array.isArray(result.listings)
        ? result.listings.length
        : 0,

      filters: result.filters || {},

      meta: result.meta || {},

      listings: Array.isArray(result.listings)
        ? result.listings
        : [],
    });
  } catch (error) {
    console.error("Search error:", error);

    res.status(500).json({
      success: false,
      count: 0,
      error: error.message,
      listings: [],
    });
  }
});

app.post("/api/economics/max-bid", (req, res) => {
  try {
    const body = req.body || {};

    const vehicles = Array.isArray(body.vehicles)
      ? body.vehicles
      : [body];

    console.log(`\n💰 MAX BID request: ${vehicles.length} vehicle(s)`);

    // Тип повреждения и топливо берём из локального реестра лотов —
    // они нужны для запасной оценки ремонта, когда ASSESSOR её не дал.
    const listings = new Map();

    // Продавца видно только на странице лота: он лежит в истории,
    // куда его записал сбор фотографий, а в реестре его чаще нет.
    const sellers = new Map();

    for (const entry of history.readAll()) {
      if (entry.lotDetails?.seller)
        sellers.set(String(entry.lotNumber), entry.lotDetails.seller);
    }

    const results = vehicles.map((vehicle) => {
      const listing = bidCars.findByLotNumber(vehicle.lotNumber);

      if (listing)
        listings.set(String(vehicle.lotNumber), listing);

      // Разбор фотографий, если он уже делался для этого лота.
      const photoAssessment = photoAssessor.getCached(vehicle.lotNumber);

      const seller = vehicle.seller || listing?.seller || sellers.get(String(vehicle.lotNumber));

      return calculateMaxBid(
        {
          ...(listing || {}),
          ...vehicle,
          ...(seller ? { seller } : {}),
          ...(photoAssessment ? { photoAssessment } : {}),
        },
        body.rates || {}
      );
    });

    if (body.saveHistory !== false) {
      const saved = history.appendRun(
        results.map((result, index) => {
          const vehicle = vehicles[index] || {};
          const listing = listings.get(String(result.lotNumber)) || {};

          return {
            lotNumber: result.lotNumber,
            vin: vehicle.vin || listing.vin || null,
            make: listing.make || vehicle.make || null,
            model: listing.model || vehicle.model || null,
            year: listing.year || vehicle.year || null,
            url: listing.url || null,
            primaryDamage: listing.primaryDamage || null,
            saleDate: listing.saleDate || null,
            bidAtAnalysisUsd: listing.currentBid ?? vehicle.currentBid ?? null,
            marketValueUsd: vehicle.marketValueUsd ?? null,
            repairCostUsd: result.breakdown?.repairCostUsd ?? null,
            repairCostSource: result.repairCostSource || null,
            damageType: result.damageType || null,
            maxBidUsd: result.maxBidUsd ?? null,
            viable: result.viable === true,
            // Прогноз bid.cars и прибыль при нём — основа решения.
            forecast: result.forecast || null,
            profit: result.profit || null,
            verdictReason: result.reason || null,
            // Без раскладки нельзя объяснить, почему потолок именно такой.
            breakdown: result.breakdown || null,
            assumptions: result.assumptions || null,
            notViableReason: result.viable === false ? result.reason : null,
            photoStatus: result.photoStatus || null,
            photosAnalyzed: result.photosAnalyzed ?? null,
            /*
             * Решение выносит формула по прогнозу bid.cars (выбор Mikita
             * 14.09). Вердикт ORCHESTRATOR остаётся, только когда прогноза
             * нет. Пока нет снимков или цены рынка, в историю уходит
             * состояние ожидания, а вердикт аналитиков придерживается.
             */
            decision: result.verdict
              ? result.verdict
              : vehicle.decision || null,
            decisionHeld: ["PENDING_PHOTOS", "NEEDS_MARKET_DATA"].includes(result.verdict)
              ? vehicle.decision || null
              : null,
            finalScore: vehicle.finalScore ?? null,
            confidence: vehicle.confidence || null,
          };
        })
      );

      console.log(`   📝 В историю записано: ${saved.length}`);
    }

    results.forEach(result => {
      const source = result.repairCostSource === "norm"
        ? ` (ремонт по нормативу: ${result.damageType})`
        : "";

      console.log(
        `   ${result.lotNumber || "—"}: ` +
        (result.viable
          ? `$${result.maxBidUsd}${source}`
          : `— (${result.reason})`)
      );
    });

    res.json({
      success: true,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("Max bid error:", error);

    res.status(500).json({
      success: false,
      error: error.message,
      results: [],
    });
  }
});

/*
 * Рыночная цена по объявлениям Беларуси (auto.kufar.by, ab.onliner.by).
 * Узел Dify перед MARKET ANALYST шлёт тот же список отобранных лотов,
 * что и PHOTO ASSESS. Чего в нём не хватает — марки, года, пробега —
 * добираем из локального реестра лотов.
 */
app.post("/api/market/prices", async (req, res) => {
  try {
    const body = req.body || {};

    const requested = Array.isArray(body.vehicles)
      ? body.vehicles
      : (body.selectedLots || []).map(item => ({
        ...(item.listing || {}),
        lotNumber: item.listing?.lotNumber ?? item.selector?.lotNumber,
      }));

    if (requested.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Нужен список vehicles или selectedLots",
        results: [],
      });
    }

    console.log(`\n🏷️ Цены Беларуси: ${requested.length} лот(ов)`);

    const results = [];

    // По одному: площадкам незачем видеть от нас пачку одновременных запросов.
    for (const vehicle of requested) {
      const listing = bidCars.findByLotNumber(vehicle.lotNumber) || {};
      const pick = field => vehicle[field] ?? listing[field] ?? null;

      const result = await marketPrices.lookup({
        lotNumber: vehicle.lotNumber,
        make: pick("make"),
        model: pick("model"),
        year: pick("year"),
        mileage: pick("mileage"),
      });

      console.log(
        `   ${result.lotNumber || "—"}: ` +
        (result.marketValueUsd
          ? `$${result.marketValueUsd} по ${result.analogsCount} аналогам (${result.match.level})`
          : `— (${result.reason})`) +
        (result.cached ? " [кэш]" : "")
      );

      results.push(result);
    }

    res.json({
      success: true,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("Market prices error:", error);

    res.status(500).json({
      success: false,
      error: error.message,
      results: [],
    });
  }
});

app.post("/api/photos/assess", async (req, res) => {
  try {
    const body = req.body || {};

    // Номера лотов ищем в любой структуре: так узел Dify может слать
    // готовый список отобранных лотов без промежуточной подготовки.
    const collectLotNumbers = (node, acc) => {
      if (Array.isArray(node)) {
        node.forEach(item => collectLotNumbers(item, acc));
      } else if (node && typeof node === "object") {
        if (node.lotNumber)
          acc.add(String(node.lotNumber));

        Object.values(node).forEach(value => collectLotNumbers(value, acc));
      }

      return acc;
    };

    const lotNumbers = Array.isArray(body.lotNumbers)
      ? body.lotNumbers
      : [...collectLotNumbers(body, new Set())];

    if (lotNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Нужен список lotNumbers",
        assessments: [],
      });
    }

    console.log(`\n📷 Оценка по фото: ${lotNumbers.length} лот(ов)`);

    // Ссылку на страницу лота и заявленное повреждение берём из реестра —
    // снаружи их передавать не нужно.
    const lots = lotNumbers.map((lotNumber) => {
      const listing = bidCars.findByLotNumber(lotNumber) || {};

      return {
        lotNumber,
        url: listing.url || null,
        make: listing.make || null,
        model: listing.model || null,
        year: listing.year || null,
        primaryDamage: listing.primaryDamage || null,
        fuelType: listing.fuelType || null,
      };
    });

    // Собираем только то, что уже лежит на диске: обращаться к Bid.Cars
    // прямо во время анализа нельзя — он блокирует со второго лота,
    // и прогон вставал бы на несколько минут ради отказа.
    const photosByLot = {};

    for (const lot of lots) {
      const onDisk = photoCollector.readPhotoDir(lot.lotNumber);

      if (onDisk.length > 0)
        photosByLot[String(lot.lotNumber)] = onDisk;
    }

    const assessments = await photoAssessor.assess(lots, photosByLot);

    // Лоты без снимков уходят в фоновую очередь и будут собраны позже,
    // после чего ставка пересчитается сама.
    const missing = assessments
      .filter(item => !item.available)
      .map(item => ({ lotNumber: item.lotNumber }));

    const queued = photoQueue.enqueue(missing, body.runId || null);

    if (queued > 0)
      console.log(`   📥 В очередь на сбор фото: ${queued}`);

    res.json({
      success: true,
      count: assessments.length,
      queuedForPhotos: queued,
      assessments,
    });
  } catch (error) {
    console.error("Photo assess error:", error);

    res.status(500).json({
      success: false,
      error: error.message,
      assessments: [],
    });
  }
});

/*
 * Сколько машин попадает под запрос, у скольких уже есть снимки
 * и сколько времени займёт добрать остальные. Нужно, чтобы решение
 * о сборе принималось осознанно, а не вслепую.
 */
const planPhotos = (filters = {}) => {
  const cache = bidCars.loadCache();
  const seen = new Set();

  const matching = [];

  for (const bucket of Object.values(cache.buckets || {})) {
    for (const vehicle of bucket.vehicles || []) {
      const lot = String(vehicle.lotNumber || "");

      if (!lot || seen.has(lot) || !vehicle.url)
        continue;

      seen.add(lot);

      if (filters.make && !new RegExp(filters.make, "i").test(vehicle.make || ""))
        continue;

      if (filters.models?.length) {
        const model = String(vehicle.model || "").toLowerCase();
        const hit = filters.models.some(
          m => model.includes(String(m).toLowerCase())
        );

        if (!hit)
          continue;
      }

      if (filters.yearFrom && Number(vehicle.year) < filters.yearFrom)
        continue;

      if (filters.yearTo && Number(vehicle.year) > filters.yearTo)
        continue;

      if (filters.mileageMax && vehicle.mileage
        && Number(vehicle.mileage) > filters.mileageMax)
        continue;

      if (filters.startCodes?.length) {
        const code = bidCars.normalizeStartCode(vehicle.runAndDrive);

        if (!filters.startCodes.includes(code))
          continue;
      }

      matching.push(vehicle);
    }
  }

  const withPhotos = matching.filter(
    vehicle => photoCollector.readPhotoDir(vehicle.lotNumber).length > 0
  );

  const missing = matching.filter(
    vehicle => photoCollector.readPhotoDir(vehicle.lotNumber).length === 0
  );

  // Сбор идёт по одному лоту раз в четыре минуты — иначе аукцион
  // начинает отбивать запросы.
  const minutesNeeded = missing.length * 4;

  /*
   * Сами машины, а не только счётчик: иначе непонятно, что стоит
   * за цифрой «подходит 42» и стоит ли вообще запускать анализ.
   * Ближайшие торги сверху — по ним решение нужно раньше.
   */
  const vehicles = matching
    .map((vehicle) => {
      const assessment = photoAssessor.getCached(vehicle.lotNumber);

      return {
        lotNumber: vehicle.lotNumber,
        year: vehicle.year ?? null,
        make: vehicle.make ?? null,
        model: vehicle.model ?? null,
        mileage: vehicle.mileage ?? null,
        currentBid: vehicle.currentBid ?? null,
        primaryDamage: describeDamage(
          vehicle.primaryDamage,
          vehicle.secondaryDamage
        ),
        saleDate: vehicle.saleDate ?? null,
        auctionEstimateMin: vehicle.auctionEstimateMin ?? null,
        auctionEstimateMax: vehicle.auctionEstimateMax ?? null,
        url: vehicle.url ?? null,
        photoCount: photoCollector.readPhotoDir(vehicle.lotNumber).length,
        severity: assessment?.available ? assessment.severity : null,
        repairCostMin: assessment?.repairCostMin ?? null,
        repairCostMax: assessment?.repairCostMax ?? null,
      };
    })
    .sort((a, b) => {
      const aDate = a.saleDate ? new Date(a.saleDate).getTime() : Infinity;
      const bDate = b.saleDate ? new Date(b.saleDate).getTime() : Infinity;

      return aDate - bDate;
    });

  return {
    matching: matching.length,
    withPhotos: withPhotos.length,
    missing: missing.length,
    minutesNeeded,
    trafficMb: Math.round(missing.length * 1.4),
    lots: missing.map(vehicle => ({ lotNumber: vehicle.lotNumber })),
    vehicles,
  };
};

app.post("/api/photos/plan", (req, res) => {
  const body = req.body || {};
  const filters = Object.keys(body).length ? body : (lastSearch?.filters || {});
  const plan = planPhotos(filters);

  res.json({
    success: true,
    ...plan,
    lots: undefined,
    query: lastSearch,
  });
});

app.get("/api/search/last", (req, res) => {
  res.json({ success: true, lastSearch });
});

app.post("/api/photos/collect", (req, res) => {
  const body = req.body || {};

  /*
   * Явный список лотов важнее фильтров: он нужен, чтобы пересобрать
   * несколько конкретных машин, а не всю выборку заново. Раньше
   * список молча игнорировался, и запрос на четыре лота ставил
   * в очередь двести пятьдесят.
   */
  const explicit = Array.isArray(body.lotNumbers) ? body.lotNumbers : null;

  const lots = explicit
    ? explicit.map(lotNumber => ({ lotNumber: String(lotNumber) }))
    : planPhotos(body).lots;

  const queued = photoQueue.enqueue(lots, body.runId || null);

  console.log(`\n📥 Запрошен сбор фото: ${queued} лот(ов)`);

  res.json({
    success: true,
    queued,
    minutesNeeded: explicit ? lots.length * 4 : planPhotos(body).minutesNeeded,
    totalPending: photoQueue.read().items.length,
  });
});

app.post("/api/photos/queue/clear", (req, res) => {
  const removed = photoQueue.clear();

  console.log(`\n🧹 Очередь сбора фото очищена: ${removed} лот(ов)`);

  res.json({ success: true, removed });
});

/*
 * Снимки и разбор по ним — рядом, чтобы вывод агента можно было
 * сверить глазами. Без этого «ремонт $55 000» остаётся утверждением,
 * которое нечем проверить.
 */
/*
 * Состояние очереди объявлено ДО маршрута с номером лота: иначе
 * Express считает слово «queue» номером лота и всегда отдаёт пустоту.
 */
app.get("/api/photos/queue", (req, res) => {
  const runId = req.query.runId ? String(req.query.runId) : null;

  res.json({
    success: true,
    ...photoQueue.stats(runId),
    lastCollected: photoWorker.lastResult,
  });
});

app.get("/api/photos/:lotNumber", (req, res) => {
  const lotNumber = String(req.params.lotNumber);
  const files = photoCollector.readPhotoDir(lotNumber);

  res.json({
    success: true,
    lotNumber,
    count: files.length,
    photos: files.map((_, index) => index),
    assessment: photoAssessor.getCached(lotNumber),
  });
});

app.get("/api/photos/:lotNumber/:index", async (req, res) => {
  const files = photoCollector.readPhotoDir(req.params.lotNumber);
  const file = files[Number(req.params.index)];

  if (!file)
    return res.status(404).json({ success: false, error: "Снимок не найден" });

  // Снимки экрана весят под мегабайт, а в ленте их девять на карточку.
  // Для миниатюр отдаём уменьшенную копию — в шестьдесят раз легче.
  if (req.query.thumb) {
    try {
      const thumb = await sharp(file)
        .resize(320)
        .jpeg({ quality: 72 })
        .toBuffer();

      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "private, max-age=86400");

      return res.send(thumb);
    } catch (error) {
      console.error("Миниатюра:", error.message);
    }
  }

  res.sendFile(file);
});

app.get("/history", (req, res) => {
  res.sendFile(path.join(__dirname, "history", "page.html"));
});

app.get("/api/history", (req, res) => {
  const entries = history.readAll();
  const lot = req.query.lot ? String(req.query.lot) : null;

  const filtered = lot
    ? entries.filter(entry => String(entry.lotNumber) === lot)
    : entries;

  /*
   * Дата торгов и ставка меняются после того, как запись создана:
   * ставка растёт до закрытия, дату мы научились разбирать позже.
   * Поэтому берём их из реестра, а не из момента анализа.
   */
  const enriched = filtered.map((entry) => {
    const listing = bidCars.findByLotNumber(entry.lotNumber) || {};

    return {
      ...entry,
      saleDate: listing.saleDate || entry.saleDate || null,
      currentBidUsd: listing.currentBid ?? null,
      bidCheckedAt: listing.bidCheckedAt || null,
      auctionEstimateMin: listing.auctionEstimateMin ?? null,
      auctionEstimateMax: listing.auctionEstimateMax ?? null,
      mileage: listing.mileage ?? null,
      primaryDamage: describeDamage(
        listing.primaryDamage || entry.primaryDamage,
        listing.secondaryDamage
      ),
      photoCount: photoCollector.readPhotoDir(entry.lotNumber).length,
    };
  });

  res.json({
    success: true,
    count: enriched.length,
    entries: enriched.reverse(),
  });
});

app.get("/api/history/summary", (req, res) => {
  res.json({
    success: true,
    ...history.buildSummary(),
  });
});

app.post("/api/history/market-reference", (req, res) => {
  const { lotNumber, polandPriceUsd, belarusPriceUsd } = req.body || {};
  if (!lotNumber) {
    return res.status(400).json({ success: false, error: "lotNumber обязателен" });
  }
  let reference;
  try {
    reference = require("./history/market-reference").normalizeMarketReference(req.body || {});
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
  const updated = history.setMarketReference(lotNumber, reference);

  if (updated === 0) {
    return res.status(404).json({
      success: false,
      error: `Лот ${lotNumber} не найден в истории`,
    });
  }

  console.log(
    `\n📌 Цены аналогов: ${lotNumber}` +
    (polandPriceUsd ? ` · Польша $${polandPriceUsd}` : "") +
    (belarusPriceUsd ? ` · Беларусь $${belarusPriceUsd}` : "")
  );

  res.json({ success: true, updatedEntries: updated });
});

app.post("/api/history/actual", (req, res) => {
  const { lotNumber, soldPriceUsd, soldAt, note } = req.body || {};

  if (!lotNumber) {
    return res.status(400).json({
      success: false,
      error: "lotNumber обязателен",
    });
  }

  const price = Number(soldPriceUsd);

  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({
      success: false,
      error: "soldPriceUsd должен быть числом",
    });
  }

  const updated = history.setActual(lotNumber, {
    soldPriceUsd: price,
    soldAt,
    note,
  });

  if (updated === 0) {
    return res.status(404).json({
      success: false,
      error: `Лот ${lotNumber} не найден в истории`,
    });
  }

  console.log(`\n🏁 Итог торгов: ${lotNumber} — $${price}`);

  res.json({
    success: true,
    updatedEntries: updated,
  });
});

app.listen(PORT, () => {
  console.log(
    `BRONVERA API running on http://localhost:${PORT}`
  );

  photoWorker.start();
  bidWatcher.start();
});