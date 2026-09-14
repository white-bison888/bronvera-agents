const defaultRates = require("./rates");

/*
 * РАСЧЁТ СДЕЛКИ: аукцион США → продажа в Беларуси.
 *
 * Отвечает на два вопроса. Первый — сколько мы заработаем, если купим
 * по цене, которую прогнозирует bid.cars. Второй — до какой ставки
 * сделка остаётся годной, то есть прибыль не меньше minProfitUsd.
 *
 * Пошлина и НДС считаются от таможенной стоимости, в которую входит
 * сама цена покупки, поэтому потолок выражается уравнением:
 *
 *   продажа − прибыль − (ремонт + комиссии + сборы) = ТС × (1 + пошлина) × (1 + НДС)
 *   ТС = цена × (1 + доля сбора аукциона) + фикс. сбор + доставка до Минска
 *
 * Всё линейно, поэтому цена находится в один шаг, без подбора.
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

/*
 * Возраст считаем по модельному году: точной даты выпуска в данных лота
 * нет. Машина ровно на границе льготы помечается — её дату выпуска нужно
 * проверить по VIN или документам.
 */
const importTaxes = (vehicle, rates, now = new Date()) => {
  const year = Number(vehicle.year);
  const ageYears = Number.isFinite(year) ? now.getFullYear() - year : null;

  const vatExempt = ageYears !== null && ageYears <= rates.evVatExemptMaxAgeYears;
  const recyclingByn = ageYears !== null && ageYears <= 3
    ? rates.recyclingFeeByn.upTo3Years
    : rates.recyclingFeeByn.older;

  return {
    ageYears,
    dutyRate: rates.evDutyFreeQuota ? 0 : rates.dutyRate,
    vatRate: vatExempt ? 0 : rates.vatRate,
    vatExempt,
    vatAgeBorderline: ageYears === rates.evVatExemptMaxAgeYears,
    recyclingFeeUsd: recyclingByn / rates.bynPerUsd,
    customsFeeUsd: rates.customsFeeByn / rates.bynPerUsd,
  };
};

const readForecast = (vehicle, rates) => {
  const min = Number(vehicle.auctionEstimateMin);
  const max = Number(vehicle.auctionEstimateMax);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min)
    return null;

  return {
    minUsd: min,
    maxUsd: max,
    expectedUsd: min + rates.forecastPosition * (max - min),
    position: rates.forecastPosition,
  };
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
      verdict: "NEEDS_MARKET_DATA",
      photoStatus: hasPhotoAssessment(photo) ? "ok" : "skipped",
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

  const taxes = importTaxes(vehicle, rates);
  const resaleValue = marketValue * (1 - rates.resaleDiscount);
  const delivery = rates.usTransportUsd + rates.oceanFreightUsd + rates.portToMinskUsd;

  // Всё, что не зависит от цены покупки и не входит в таможенную стоимость.
  const fixedCosts = repairCost + rates.bidcarsFeeUsd + rates.localCostsUsd
    + taxes.recyclingFeeUsd + taxes.customsFeeUsd;

  const costsAt = (price) => {
    const auctionFees = price * rates.auctionFeeRate + rates.auctionFeeFixed;
    const customsValue = price + auctionFees + delivery;
    const duty = customsValue * taxes.dutyRate;
    const vat = (customsValue + duty) * taxes.vatRate;
    const total = customsValue + duty + vat + fixedCosts;

    return { price, auctionFees, customsValue, duty, vat, total, profit: resaleValue - total };
  };

  const taxMultiplier = (1 + taxes.dutyRate) * (1 + taxes.vatRate);
  const customsValueAtCeiling = (resaleValue - rates.minProfitUsd - fixedCosts) / taxMultiplier;
  const ceiling = (customsValueAtCeiling - rates.auctionFeeFixed - delivery) / (1 + rates.auctionFeeRate);

  const forecast = readForecast(vehicle, rates);

  const profit = forecast
    ? {
        atMinUsd: round(costsAt(forecast.minUsd).profit),
        atExpectedUsd: round(costsAt(forecast.expectedUsd).profit),
        atMaxUsd: round(costsAt(forecast.maxUsd).profit),
      }
    : null;

  /*
   * Решение по прогнозу bid.cars (выбор Mikita 14.09):
   *   BUY   — прибыль не меньше порога даже при верхней границе прогноза;
   *   WATCH — только при нижней;
   *   SKIP  — не набирается ни при какой цене из прогноза.
   * Без прогноза вердикт не выносим: остаётся решение аналитиков.
   */
  const maxBid = Number.isFinite(ceiling) ? Math.max(0, ceiling) : 0;

  let verdict = null;

  if (maxBid <= 0)
    verdict = "SKIP";
  else if (forecast)
    verdict = maxBid >= forecast.maxUsd ? "BUY" : maxBid >= forecast.minUsd ? "WATCH" : "SKIP";

  const at = costsAt(forecast ? forecast.expectedUsd : maxBid);

  const reason = maxBid <= 0
    ? `Расходы съедают всю выручку — прибыли $${rates.minProfitUsd} нет даже при нулевой ставке`
    : !forecast
      ? "Нет прогноза цены bid.cars — вердикт по формуле не выносится"
      : verdict === "BUY"
        ? `Годно даже при верхней границе прогноза: потолок $${round(maxBid)} ≥ $${forecast.maxUsd}`
        : verdict === "WATCH"
          ? `Годно только в нижней части прогноза: потолок $${round(maxBid)} из $${forecast.minUsd}–${forecast.maxUsd}`
          : `Прогноз bid.cars $${forecast.minUsd}–${forecast.maxUsd} выше потолка $${round(maxBid)}`;

  return {
    lotNumber: vehicle.lotNumber || null,
    maxBidUsd: round(maxBid),
    currency: "USD",
    viable: maxBid > 0,
    verdict,
    reason,
    photoStatus: hasPhotoAssessment(photo) ? "ok" : "skipped",
    photosAnalyzed: photo?.photosAnalyzed ?? null,
    repairCostSource,
    damageType,
    forecast: forecast
      ? { ...forecast, expectedUsd: round(forecast.expectedUsd) }
      : null,
    profit,
    // Раскладка при ожидаемой цене покупки, а без прогноза — при потолке.
    breakdown: {
      marketValueUsd: round(marketValue),
      resaleValueUsd: round(resaleValue),
      purchasePriceUsd: round(at.price),
      repairCostUsd: round(repairCost),
      auctionFeesUsd: round(at.auctionFees),
      usTransportUsd: rates.usTransportUsd,
      oceanFreightUsd: rates.oceanFreightUsd,
      portToMinskUsd: rates.portToMinskUsd,
      bidcarsFeeUsd: rates.bidcarsFeeUsd,
      customsValueUsd: round(at.customsValue),
      customsDutyUsd: round(at.duty),
      vatUsd: round(at.vat),
      recyclingFeeUsd: round(taxes.recyclingFeeUsd),
      customsFeeUsd: round(taxes.customsFeeUsd),
      localCostsUsd: rates.localCostsUsd,
      totalLandedCostUsd: round(at.total),
      profitUsd: round(at.profit),
    },
    // Все ставки целиком: без них раскладка остаётся набором чисел,
    // который нечем проверить и не с чем спорить.
    assumptions: {
      market: "Беларусь, ввоз компанией",
      forecastPosition: rates.forecastPosition,
      minProfitUsd: rates.minProfitUsd,
      resaleDiscount: rates.resaleDiscount,
      repairCostBasis: rates.repairCostBasis,
      auctionFeeRate: rates.auctionFeeRate,
      auctionFeeFixed: rates.auctionFeeFixed,
      usTransportUsd: rates.usTransportUsd,
      oceanFreightUsd: rates.oceanFreightUsd,
      portToMinskUsd: rates.portToMinskUsd,
      bidcarsFeeUsd: rates.bidcarsFeeUsd,
      localCostsUsd: rates.localCostsUsd,
      dutyRate: taxes.dutyRate,
      evDutyFreeQuota: rates.evDutyFreeQuota,
      vatRate: taxes.vatRate,
      vatExempt: taxes.vatExempt,
      vatAgeBorderline: taxes.vatAgeBorderline,
      ageYears: taxes.ageYears,
      bynPerUsd: rates.bynPerUsd,
    },
  };
};

module.exports = { calculateMaxBid };
