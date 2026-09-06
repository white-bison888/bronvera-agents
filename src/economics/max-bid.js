const defaultRates = require("./rates");

/*
 * Пошлина и НДС считаются от таможенной стоимости, в которую входит
 * сама цена покупки. Поэтому «сколько можно поставить» нельзя получить
 * простым вычитанием — величина стоит по обе стороны равенства.
 *
 * Уравнение разворачивается так:
 *
 *   выручка − резерв − прибыль − ремонт − местные расходы = ввоз × K
 *   K = (1 + пошлина) × (1 + НДС)
 *   ввоз = цена × (1 + сбор аукциона) + фикс.сборы + перевозки
 *
 * Отсюда цена выражается в один шаг, без подбора.
 */

const pickRepairCost = (vehicle, basis) => {
  const min = Number.isFinite(vehicle.repairCostMin) ? vehicle.repairCostMin : null;
  const max = Number.isFinite(vehicle.repairCostMax) ? vehicle.repairCostMax : null;

  if (min === null && max === null)
    return null;

  if (basis === "min")
    return min !== null ? min : max;

  if (basis === "avg" && min !== null && max !== null)
    return (min + max) / 2;

  return max !== null ? max : min;
};

const round = value => Math.round(value);

const calculateMaxBid = (vehicle, overrides = {}) => {
  const rates = { ...defaultRates, ...overrides };

  const marketValue = Number.isFinite(vehicle.marketValueUsd)
    ? vehicle.marketValueUsd
    : null;

  if (marketValue === null || marketValue <= 0) {
    return {
      lotNumber: vehicle.lotNumber || null,
      maxBidUsd: null,
      viable: false,
      reason: "Неизвестна рыночная стоимость автомобиля",
    };
  }

  const repairCost = pickRepairCost(vehicle, rates.repairCostBasis);

  if (repairCost === null) {
    return {
      lotNumber: vehicle.lotNumber || null,
      maxBidUsd: null,
      viable: false,
      reason: "Неизвестна стоимость ремонта — расчёт был бы выдумкой",
    };
  }

  const resaleValue = marketValue * rates.resaleFactor;
  const riskReserve = resaleValue * rates.riskReserveRate;
  const targetProfit = resaleValue * rates.targetProfitRate;

  const importBudget
    = resaleValue - riskReserve - targetProfit - repairCost - rates.localCostsUsd;

  const taxMultiplier = (1 + rates.dutyRate) * (1 + rates.vatRate);
  const customsValue = importBudget / taxMultiplier;

  const shipping = rates.usTransportUsd + rates.oceanFreightUsd;
  const maxBid
    = (customsValue - rates.auctionFeeFixed - shipping) / (1 + rates.auctionFeeRate);

  if (!Number.isFinite(maxBid) || maxBid <= 0) {
    return {
      lotNumber: vehicle.lotNumber || null,
      maxBidUsd: 0,
      viable: false,
      reason:
        "Расходы съедают всю выручку — лот не окупается даже при нулевой ставке",
      breakdown: {
        resaleValueUsd: round(resaleValue),
        repairCostUsd: round(repairCost),
      },
    };
  }

  const auctionFees = maxBid * rates.auctionFeeRate + rates.auctionFeeFixed;
  const duty = customsValue * rates.dutyRate;
  const vat = (customsValue + duty) * rates.vatRate;

  return {
    lotNumber: vehicle.lotNumber || null,
    maxBidUsd: round(maxBid),
    currency: "USD",
    viable: true,
    breakdown: {
      resaleValueUsd: round(resaleValue),
      repairCostUsd: round(repairCost),
      auctionFeesUsd: round(auctionFees),
      usTransportUsd: rates.usTransportUsd,
      oceanFreightUsd: rates.oceanFreightUsd,
      customsDutyUsd: round(duty),
      vatUsd: round(vat),
      localCostsUsd: rates.localCostsUsd,
      riskReserveUsd: round(riskReserve),
      targetProfitUsd: round(targetProfit),
      totalLandedCostUsd: round(
        maxBid + auctionFees + shipping + duty + vat + repairCost + rates.localCostsUsd,
      ),
    },
    assumptions: {
      resaleFactor: rates.resaleFactor,
      repairCostBasis: rates.repairCostBasis,
      targetProfitRate: rates.targetProfitRate,
      riskReserveRate: rates.riskReserveRate,
    },
  };
};

module.exports = { calculateMaxBid };
