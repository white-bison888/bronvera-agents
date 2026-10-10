const { calculateMaxBid } = require("./max-bid");

/*
 * Оценка лота для другого рынка назначения (07.10.2026): лот на аукционе
 * один, а выгода в Польше и в Беларуси разная. Беларусь считается как раньше
 * при записи прогноза; остальные рынки собираются здесь из того, что у лота
 * уже есть (ремонт по фото, прогноз bid.cars, VIN), и цены на этом рынке из
 * кэша — без обращений к площадкам, чтобы ответ истории не задерживался.
 */

// Подсказка комплектации из VIN: только у не-Tesla, у Tesla NHTSA её не называет.
const trimHintOf = (vinInfo) => {
  const trim = vinInfo?.ok && !/tesla/i.test(vinInfo.make || "") ? String(vinInfo.trim || "") : "";

  return trim && !trim.includes(",") && !trim.includes("·") ? trim : "";
};

/*
 * Топливо и объём двигателя из расшифровки VIN: от них зависит и пошлина в Беларуси
 * (бензин и дизель — как физлицо, по объёму), и акциз в Польше.
 */
const vinFactsOf = (vinInfo) => (vinInfo && vinInfo.ok
  ? { fuelKind: vinInfo.fuel || undefined, displacementL: vinInfo.displacementL || undefined }
  : {});

const lookupKey = (entry, listing, vinInfo) => ({
  lotNumber: entry.lotNumber,
  make: entry.make || listing.make,
  model: entry.model || listing.model,
  year: entry.year || listing.year,
  mileage: listing.mileage ?? entry.mileage,
  vin: entry.vin || listing.vin,
  trimHint: trimHintOf(vinInfo),
});

/*
 * Готовая оценка для рынка или причина, почему её пока нет:
 *   pending        — цена на этом рынке ещё не собрана;
 *   no-price       — аналогов не нашлось (причина в priceReason);
 *   waiting-photos — ремонт ещё не оценён по снимкам;
 *   ok             — расчёт готов.
 */
const buildDeal = ({ destination, entry, listing = {}, vinInfo = null, prices }) => {
  const key = lookupKey(entry, listing, vinInfo);
  const price = prices.peek(key);

  if (!price)
    return { destination, status: "pending" };

  const base = {
    destination,
    priceStatus: price.status,
    priceLevel: price.match?.level || null,
    analogs: price.analogsCount ?? null,
    priceReason: price.reason || null,
    trimFellBack: price.plaid?.fellBack === true,
  };

  if (price.status !== "ok" || !price.marketValueUsd)
    return { ...base, status: "no-price", marketValueUsd: null };

  if (!Number.isFinite(entry.repairCostUsd))
    return { ...base, status: "waiting-photos", marketValueUsd: price.marketValueUsd };

  const result = calculateMaxBid(
    {
      lotNumber: entry.lotNumber,
      make: key.make,
      model: key.model,
      year: key.year,
      mileage: key.mileage,
      primaryDamage: entry.primaryDamage,
      location: entry.lotDetails?.location || listing.location,
      seller: entry.lotDetails?.seller || listing.seller,
      auctionEstimateMin: entry.auctionEstimateMin ?? listing.auctionEstimateMin,
      auctionEstimateMax: entry.auctionEstimateMax ?? listing.auctionEstimateMax,
      buyNowUsd: listing.buyNowUsd,
      fuelType: listing.fuelType,
      ...vinFactsOf(vinInfo),
      marketValueUsd: price.marketValueUsd,
      // Ремонт уже оценён по снимкам для записи прогноза: тот же ремонт, другая страна.
      photoAssessment: { available: true, repairCostMin: entry.repairCostUsd, repairCostMax: entry.repairCostUsd },
    },
    { destination, requireKnownSeller: false }
  );

  return {
    ...base,
    status: result.maxBidUsd === null ? "no-result" : "ok",
    marketValueUsd: price.marketValueUsd,
    maxBidUsd: result.maxBidUsd,
    verdict: result.verdict,
    reason: result.reason,
    profit: result.profit,
    breakdown: result.breakdown ? { totalLandedCostUsd: result.breakdown.totalLandedCostUsd, customsDutyUsd: result.breakdown.customsDutyUsd, exciseUsd: result.breakdown.exciseUsd, vatUsd: result.breakdown.vatUsd } : null,
    exciseRate: result.assumptions?.exciseRate ?? null,
    exciseAssumed: result.assumptions?.exciseAssumed === true,
    // Ставки ввоза — для показа в строке лота: пошлина, акциз и НДС в долях.
    taxes: {
      scheme: result.assumptions?.scheme ?? null,
      dutyRate: result.assumptions?.dutyRate ?? null,
      exciseRate: result.assumptions?.exciseRate ?? null,
      vatRate: result.assumptions?.vatRate ?? null,
      // Беларусь, физлицо: пошлина суммой (зависит от объёма и стоимости), возраст и объём.
      dutyUsd: result.breakdown?.customsDutyUsd ?? null,
      ageCategory: result.assumptions?.ageCategory ?? null,
      ageBorderline: result.assumptions?.ageBorderline === true,
      volumeCc: result.assumptions?.volumeCc ?? null,
    },
  };
};

/*
 * Фоновое наполнение кэша цен: по нескольку лотов за вызов, по одному
 * запросу за раз и без повторов, пока предыдущий не закончился.
 */
const createFiller = ({ prices, getVinInfo, perCall = 4, log = () => {} }) => {
  let running = false;

  return (items) => {
    if (running || !items.length)
      return;

    running = true;

    (async () => {
      for (const { entry, listing } of items.slice(0, perCall)) {
        try {
          await prices.lookup(lookupKey(entry, listing, getVinInfo(entry.vin || listing.vin)));
        } catch (error) {
          log(`Цена для ${entry.lotNumber}: ${error.message}`);
        }
      }
    })().finally(() => { running = false; });
  };
};

module.exports = { buildDeal, createFiller, lookupKey, trimHintOf, vinFactsOf };
