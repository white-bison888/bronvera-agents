#!/usr/bin/env node
/*
 * Разовая дозапись объявлений цены в Беларуси в уже сделанные прогнозы
 * (15.09.2026). До этого история хранила только медиану, а ссылки жили
 * в кэше площадок сутки.
 *
 * Берём из кэша ту выборку, по которой считалась цена, и только если её
 * медиана совпадает с ценой в записи — иначе это уже другие объявления.
 * В старом кэше ссылки есть лишь у ближайших, такие снимки помечены
 * complete: false.
 *
 *   node scripts/backfill-market-listings.js          — только посчитать
 *   node scripts/backfill-market-listings.js --write  — записать (с копией файла)
 */
const fs = require("fs");
const path = require("path");
const { MinskMarketPrices, marketSnapshot } = require("../src/market/minsk-prices");

const DATA = path.join(process.cwd(), "data");
const HISTORY = path.join(DATA, "recommendations-history.json");
const write = process.argv.includes("--write");

const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

const history = readJson(HISTORY);
const marketCache = readJson(path.join(DATA, "market-prices-cache.json"));
const bidcars = readJson(path.join(DATA, "bidcars-cache.json"));

const mileageByLot = new Map();
for (const bucket of Object.values(bidcars.buckets || {})) {
  for (const vehicle of bucket.vehicles || []) {
    if (vehicle.lotNumber && vehicle.mileage != null)
      mileageByLot.set(String(vehicle.lotNumber), vehicle.mileage);
  }
}

const stats = { entries: 0, alreadyHad: 0, filled: 0, complete: 0, noCache: 0, otherPrice: 0 };

for (const entry of history) {
  if (!entry.marketValueUsd)
    continue;

  stats.entries++;

  if (entry.market) {
    stats.alreadyHad++;
    continue;
  }

  const cached = marketCache[MinskMarketPrices.cacheKey({
    make: entry.make,
    model: entry.model,
    year: Number(entry.year),
    mileage: mileageByLot.get(String(entry.lotNumber)),
  })];

  if (!cached) {
    stats.noCache++;
    continue;
  }

  if (cached.marketValueUsd !== entry.marketValueUsd) {
    stats.otherPrice++;
    continue;
  }

  entry.market = marketSnapshot(cached);
  stats.filled++;
  if (entry.market.complete)
    stats.complete++;
}

console.log(stats);

if (write && stats.filled) {
  const backup = `${HISTORY}.bak-2026-09-15-market`;
  fs.copyFileSync(HISTORY, backup);
  // Как в store.js: через временный файл, чтобы прерванная запись не обрезала историю.
  fs.writeFileSync(`${HISTORY}.tmp`, JSON.stringify(history, null, 2), "utf8");
  fs.renameSync(`${HISTORY}.tmp`, HISTORY);
  console.log(`записано, копия: ${backup}`);
}
