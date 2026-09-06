const express = require("express");
const cors = require("cors");

const BidCarsProvider = require("./providers/bidcars");
const { calculateMaxBid } = require("./economics/max-bid");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const bidCars = new BidCarsProvider();

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
    const results = vehicles.map((vehicle) => {
      const listing = bidCars.findByLotNumber(vehicle.lotNumber);

      return calculateMaxBid(
        listing ? { ...listing, ...vehicle } : vehicle,
        body.rates || {}
      );
    });

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

app.listen(PORT, () => {
  console.log(
    `BRONVERA API running on http://localhost:${PORT}`
  );
});