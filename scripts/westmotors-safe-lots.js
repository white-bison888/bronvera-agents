/*
 * Разовая постановка лотов из подборки WESTMOTORS VerifiedLots в нашу очередь (07.10.2026):
 * тот же путь, что у быстрого поиска, но лоты берутся по номерам из реестра bid.cars.
 * Запуск на сервере: node scripts/westmotors-safe-lots.js
 */
require("dotenv").config();
const history = require("../src/history/store");
const photoQueue = require("../src/photos/queue");
const BidCarsProvider = require("../src/providers/bidcars");
const PhotoAssessor = require("../src/vision/photo-assessor");
const { MinskMarketPrices } = require("../src/market/minsk-prices");
const { getVinInfo } = require("../src/providers/tesla-vin");
const { runQuickSearch } = require("../src/quick-search/runner");

const LOTS = [
  "1-71095416", "1-71090896", "1-71104916", "1-70830906", "1-58756036", "1-69457896", "1-70063916",
  "1-70267186", "0-46057979", "1-64699906", "1-70420896", "1-71096706", "1-93294965",
];

(async () => {
  const bidCars = new BidCarsProvider();
  const listings = LOTS.map(lot => bidCars.findByLotNumber(lot)).filter(Boolean);

  console.log(`Найдено в реестре: ${listings.length} из ${LOTS.length}`);

  const result = await runQuickSearch({
    filters: { source: "westmotors-verified-lots", maxResults: LOTS.length },
    jobId: "westmotors-safe",
    deps: {
      searchCars: async () => ({ listings }),
      vinInfo: getVinInfo(),
      marketPrices: new MinskMarketPrices(),
      photoAssessor: new PhotoAssessor(),
      history,
      photoQueue,
    },
    report: (step, detail) => console.log(`   ${step}: ${detail}`),
  });

  console.log("Готово:", JSON.stringify(result.stats));
})().catch((error) => {
  console.error("Не удалось:", error.message);
  process.exit(1);
});
