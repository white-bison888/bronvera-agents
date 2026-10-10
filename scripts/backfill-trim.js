/*
 * Разовый обход страниц лотов с торгами впереди, у которых ещё нет комплектации
 * (07.10.2026): тот же заход наблюдателя ставок, что идёт по расписанию, —
 * заодно читает комплектацию, просмотры и признак выкупа Fast Buy.
 * Запуск на сервере: node scripts/backfill-trim.js
 */
require("dotenv").config();
const history = require("../src/history/store");
const BidCarsProvider = require("../src/providers/bidcars");
const BidWatcher = require("../src/photos/bid-watcher");
const { trimFromListing } = require("../src/providers/lot-trim");
const { withRun } = require("../src/costs/ledger");

(async () => {
  const bidCars = new BidCarsProvider();
  const watcher = new BidWatcher({ bidCars });
  const now = Date.now();
  const seen = new Map();

  for (const entry of history.readAll()) {
    const lot = String(entry.lotNumber);
    const listing = bidCars.findByLotNumber(lot);

    if (!listing || !listing.url || !listing.saleDate || Date.parse(listing.saleDate) <= now)
      continue;
    if (entry.lotDetails?.trim || trimFromListing(listing.trim))
      continue;

    seen.set(lot, { lot, url: listing.url, msToClose: Date.parse(listing.saleDate) - now });
  }

  const lots = [...seen.values()].sort((a, b) => a.msToClose - b.msToClose);

  console.log(`К обходу: ${lots.length} лотов`);

  if (lots.length)
    await withRun("backfill-trim", () => watcher.checkLots(lots, { pauseMs: [60000, 150000] }));

  console.log("Обход закончен");
})().catch((error) => {
  console.error("Обход не удался:", error.message);
  process.exit(1);
});
