require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const BidCarsProvider = require("./providers/bidcars");
const { calculateMaxBid } = require("./economics/max-bid");
const history = require("./history/store");
const LotPhotoCollector = require("./providers/lot-photos");
const PhotoAssessor = require("./vision/photo-assessor");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const bidCars = new BidCarsProvider();
const photoCollector = new LotPhotoCollector();
const photoAssessor = new PhotoAssessor();

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

      maxResults,
      maxPages,
    });

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

    const results = vehicles.map((vehicle) => {
      const listing = bidCars.findByLotNumber(vehicle.lotNumber);

      if (listing)
        listings.set(String(vehicle.lotNumber), listing);

      // Разбор фотографий, если он уже делался для этого лота.
      const photoAssessment = photoAssessor.getCached(vehicle.lotNumber);

      return calculateMaxBid(
        {
          ...(listing || {}),
          ...vehicle,
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
            decision: vehicle.decision || null,
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

    const photosByLot = await photoCollector.collect(
      lots.filter(lot => lot.url)
    );

    const assessments = await photoAssessor.assess(lots, photosByLot);

    res.json({
      success: true,
      count: assessments.length,
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

app.get("/history", (req, res) => {
  res.sendFile(path.join(__dirname, "history", "page.html"));
});

app.get("/api/history", (req, res) => {
  const entries = history.readAll();
  const lot = req.query.lot ? String(req.query.lot) : null;

  const filtered = lot
    ? entries.filter(entry => String(entry.lotNumber) === lot)
    : entries;

  res.json({
    success: true,
    count: filtered.length,
    entries: [...filtered].reverse(),
  });
});

app.get("/api/history/summary", (req, res) => {
  res.json({
    success: true,
    ...history.buildSummary(),
  });
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
});