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

/*
 * Оценка считается состоявшейся, только если модель действительно
 * что-то разглядела и назвала стоимость ремонта. Ответы вида
 * «на снимках ничего не видно» приходят с available: false.
 */
const hasPhotoAssessment = (photo) => {
  if (!photo || photo.available === false)
    return false;

  return Number.isFinite(photo.repairCostMin)
    || Number.isFinite(photo.repairCostMax);
};

const calculateMaxBid = (vehicle, overrides = {}) => {
  const rates = { ...defaultRates, ...overrides };

  /*
   * ГЛАВНОЕ ПРАВИЛО: без оценки по фотографиям заключения нет.
   *
   * Текстовое описание лота говорит «повреждён перёд», но не говорит,
   * сложился ли лонжерон. Потолок ставки, посчитанный по нормативу,
   * выглядит как настоящий и ведёт к покупке вслепую, поэтому такой
   * лот остаётся без вердикта до появления пригодных снимков.
   */
  const photo = vehicle.photoAssessment;

  if (rates.requirePhotoAssessment !== false && !hasPhotoAssessment(photo)) {
    return {
      lotNumber: vehicle.lotNumber || null,
      maxBidUsd: null,
      viable: false,
      verdict: "PENDING_PHOTOS",
      photoStatus: photo ? "unusable" : "missing",
      reason: photo
        ? `Оценка по фотографиям не получилась: ${photo.reason || "снимки непригодны"}. Заключение не выдаётся.`
        : "Нет оценки по фотографиям — заключение не выдаётся",
    };
  }

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

  // Оценка по фотографиям точнее текстовой: там видны силовые элементы
  // и реальная глубина удара, поэтому она имеет приоритет.
  let repairCost = photo
    ? pickRepairCost(photo, rates.repairCostBasis)
    : null;

  let repairCostSource = repairCost === null ? "assessor" : "photo";
  let damageType = null;

  if (repairCost === null)
    repairCost = pickRepairCost(vehicle, rates.repairCostBasis);

  // Ни фотографий, ни оценки ASSESSOR — берём норматив по типу
  // повреждения и помечаем это в ответе.
  if (repairCost === null) {
    const norm = estimateRepairFromNorms(vehicle, rates);

    repairCost = pickRepairCost(norm, rates.repairCostBasis);
    repairCostSource = "norm";
    damageType = norm.damageType;
  }

  /*
   * Если известна цена живого аналога в Польше, она надёжнее любых
   * коэффициентов — это факт рынка, а не пересчёт американской витрины.
   */
  const localMarketValue = Number.isFinite(vehicle.polandPriceUsd)
    ? vehicle.polandPriceUsd
    : marketValue * rates.polandMarketFactor;

  const resaleValue = localMarketValue * rates.resaleFactor;
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
      verdict: "SKIP",
      photoStatus: hasPhotoAssessment(photo) ? "ok" : "skipped",
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
    photoStatus: hasPhotoAssessment(photo) ? "ok" : "skipped",
    photosAnalyzed: photo?.photosAnalyzed ?? null,
    repairCostSource,
    damageType,
    breakdown: {
      marketValueUsd: round(marketValue),
      localMarketValueUsd: round(localMarketValue),
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
    // Все ставки целиком: без них таблица расходов остаётся набором
    // чисел, который нечем проверить и не с чем спорить.
    assumptions: {
      polandMarketFactor: rates.polandMarketFactor,
      resaleFactor: rates.resaleFactor,
      repairCostBasis: rates.repairCostBasis,
      localPriceSource: Number.isFinite(vehicle.polandPriceUsd)
        ? "цена аналога в Польше, введена вручную"
        : "пересчёт американской оценки",
      targetProfitRate: rates.targetProfitRate,
      riskReserveRate: rates.riskReserveRate,
      auctionFeeRate: rates.auctionFeeRate,
      auctionFeeFixed: rates.auctionFeeFixed,
      usTransportUsd: rates.usTransportUsd,
      oceanFreightUsd: rates.oceanFreightUsd,
      dutyRate: rates.dutyRate,
      vatRate: rates.vatRate,
      localCostsUsd: rates.localCostsUsd,
    },
  };
};

module.exports = { calculateMaxBid };
