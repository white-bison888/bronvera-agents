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

/*
 * Bid.Cars описывает повреждения по-польски («Przód», «Inne | Dach»),
 * поэтому распознаём оба языка. Порядок важен: сначала характерные
 * случаи вроде затопления и крыши, и только потом стороны кузова.
 */
const damagePatterns = [
  ["flood", /zalan|powód|powodz|flood|water/i],
  ["hail", /grad|hail/i],
  ["roof", /dach|roof|rollover|dachowan/i],
  ["allOver", /dookoła|dookola|wszędzie|wszedzie|all\s*over|wszystko/i],
  ["minor", /rys|zarysow|scratch|minor|vandal|otarcie/i],
  ["mechanical", /mechanic|silnik|engine|skrzyni|transmission/i],
  ["front", /przód|przod|przedni|front/i],
  ["rear", /tył|tyl|tylni|tylna|rear|back/i],
  ["side", /bok|boczn|side|lewy|prawy|left|right|quarter/i],
];

const classifyDamage = (vehicle) => {
  const text = [vehicle.primaryDamage, vehicle.secondaryDamage]
    .filter(Boolean)
    .join(" ");

  if (!text)
    return "unknown";

  const match = damagePatterns.find(([, pattern]) => pattern.test(text));

  return match ? match[0] : "unknown";
};

const isElectric = vehicle => /electric|elektr|hybrid/i.test(
  String(vehicle.fuelType || "")
);

const estimateRepairFromNorms = (vehicle, rates) => {
  const damageType = classifyDamage(vehicle);
  const norm = rates.repairNorms[damageType] || rates.repairNorms.unknown;
  const multiplier = isElectric(vehicle) ? rates.evRepairMultiplier : 1;

  return {
    repairCostMin: norm[0] * multiplier,
    repairCostMax: norm[1] * multiplier,
    damageType,
  };
};

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

  let repairCost = pickRepairCost(vehicle, rates.repairCostBasis);
  let repairCostSource = "assessor";
  let damageType = null;

  // ASSESSOR не смог оценить ремонт (обычно нет фотографий) —
  // берём норматив по типу повреждения и помечаем это в ответе.
  if (repairCost === null) {
    const norm = estimateRepairFromNorms(vehicle, rates);

    repairCost = pickRepairCost(norm, rates.repairCostBasis);
    repairCostSource = "norm";
    damageType = norm.damageType;
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
      repairCostSource,
      damageType,
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
    repairCostSource,
    damageType,
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
