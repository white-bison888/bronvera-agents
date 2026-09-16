const { evaluateLot, expectedPriceUsd } = require("../screener/select");

/*
 * ЗАПАСНОЙ СПИСОК, КОГДА В БЮДЖЕТЕ НИЧЕГО НЕТ
 *
 * Решение Mikita 2026-09-15: если под марку, модель и комплектацию лоты
 * есть, но прогноз цены торгов у всех выше бюджета, показать 5 самых
 * дешёвых по прогнозу из тех, что выгодны ещё до разбора фото (ремонт по
 * нормативу типа повреждения). Дальше они идут обычным путём: фото,
 * цена в Беларуси, расчёт.
 *
 * Цены Беларуси запрашиваются по одному и не больше maxLookups раз:
 * площадкам незачем видеть пачку запросов, а поиску — ждать минуты.
 */
const cheapestPromising = async ({
  matches,
  marketPrices,
  photoAssessor = null,
  limit = 5,
  maxLookups = 25,
}) => {
  const byPrice = matches
    .map(car => ({ car, expected: expectedPriceUsd(car) }))
    .filter(item => item.expected !== null)
    .sort((a, b) => a.expected - b.expected);

  const listings = [];
  let looked = 0;

  for (const { car, expected } of byPrice) {
    if (listings.length >= limit || looked >= maxLookups)
      break;

    looked += 1;

    const market = await marketPrices.lookup({
      lotNumber: car.lotNumber,
      make: car.make,
      model: car.model,
      year: car.year,
      mileage: car.mileage,
    });

    if (!market.marketValueUsd)
      continue;

    const evaluation = evaluateLot(car, {
      market,
      photoAssessment: photoAssessor?.getCached?.(car.lotNumber) || null,
    });

    if (!(evaluation.profitAtExpectedUsd > 0))
      continue;

    // Те же подсказки, что у списка дня: SELECTOR не угадывает цену рынка и прибыль сам.
    listings.push({
      ...car,
      budgetFallback: {
        expectedPriceUsd: expected,
        marketValueBelarusUsd: market.marketValueUsd,
        profitWithoutPhotosUsd: evaluation.profitAtExpectedUsd,
        repairCostUsd: evaluation.repairCostUsd,
        repairSource: evaluation.repairSource,
      },
    });
  }

  return { listings, candidates: byPrice.length, looked };
};

module.exports = { cheapestPromising };
