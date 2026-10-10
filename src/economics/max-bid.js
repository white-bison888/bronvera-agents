const { DEFAULT_MARKET, marketOf } = require("./markets");
const { logisticsFor } = require("./logistics");
const forecastPositions = require("./forecast-positions");
const { checkSeller } = require("../providers/lot-requirements");
const { lotWarnings } = require("../providers/lot-notices");

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

/*
 * Штат стоянки для доплаты за вывоз: площадки пишут «Honolulu (HI)»,
 * «Hawaii - K... (HI)», «Anchorage (AK)». Без кода штата — по названию.
 */
const REMOTE_BY_NAME = [
  ["HI", /hawaii|honolulu/i],
  ["AK", /alaska|anchorage|fairbanks/i],
  ["PR", /puerto\s*rico|san\s*juan\s*\(pr\)/i],
];

const remoteState = (vehicle, rates) => {
  const location = String(vehicle.location || "");
  const code = (location.match(/\(([A-Z]{2})\)\s*$/) || [])[1];

  if (code && rates.remoteLocationSurchargeUsd?.[code] !== undefined)
    return code;

  const byName = REMOTE_BY_NAME.find(([, pattern]) => pattern.test(location));

  return byName && rates.remoteLocationSurchargeUsd?.[byName[0]] !== undefined ? byName[0] : null;
};

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

/*
 * Вид топлива лота: из расшифровки VIN (fuelKind), иначе по тексту fuelType.
 * От него зависит акциз в Польше.
 */
const fuelKindOf = (vehicle) => {
  if (vehicle.fuelKind)
    return vehicle.fuelKind;

  const text = String(vehicle.fuelType || "");

  if (/plug|phev/i.test(text))
    return "phev";
  if (/hybrid|гибрид/i.test(text))
    return "hybrid";
  if (/electric|elektr/i.test(text))
    return "electric";
  if (/diesel|дизел/i.test(text))
    return "diesel";
  if (/gas|benz|бенз/i.test(text))
    return "gasoline";

  return null;
};

/*
 * Польша: пошлина 10%, акциз по топливу и объёму, НДС 23%. Объём неизвестен —
 * берём верхнюю ставку и помечаем: цифра осторожная, а не точная.
 */
const importTaxesPL = (vehicle, rates, now = new Date()) => {
  const year = Number(vehicle.year);
  const ageYears = Number.isFinite(year) ? now.getFullYear() - year : null;
  const kind = fuelKindOf(vehicle);
  const volume = Number(vehicle.displacementL);
  const known = Number.isFinite(volume) && volume > 0;
  const large = !known || volume > rates.exciseEngineLimitL;

  let exciseRate;

  if (kind === "electric")
    exciseRate = rates.exciseRates.electric;
  else if (kind === "hybrid" || kind === "phev")
    exciseRate = large ? rates.exciseRates.hybridLarge : rates.exciseRates.hybridSmall;
  else
    exciseRate = large ? rates.exciseRates.gasolineLarge : rates.exciseRates.gasolineSmall;

  return {
    ageYears,
    dutyRate: rates.dutyRate,
    exciseRate,
    // Топливо или объём не известны — акциз взят по осторожной (верхней) ставке.
    exciseAssumed: kind === null || (kind !== "electric" && !known),
    fuelKind: kind,
    vatRate: rates.vatRate,
    vatExempt: false,
    vatAgeBorderline: false,
    recyclingFeeUsd: 0,
    customsFeeUsd: rates.customsFeeUsd || 0,
  };
};

/*
 * Бензин и дизель в Беларусь как физлицо (07.10.2026). Пошлина зависит от
 * таможенной стоимости (до 3 лет) и объёма двигателя, поэтому возвращаем
 * функцию от стоимости, а не долю. Без объёма пошлину не посчитать — возвращаем null.
 */
const isIceFuel = vehicle => ["gasoline", "diesel"].includes(fuelKindOf(vehicle));

const importTaxesBYIndividual = (vehicle, rates, now = new Date()) => {
  const scheme = rates.individualScheme;
  const volume = Math.round(Number(vehicle.displacementL) * 1000);

  if (!Number.isFinite(volume) || volume <= 0)
    return null;

  const year = Number(vehicle.year);
  const ageYears = Number.isFinite(year) ? now.getFullYear() - year : null;
  // Модельный год вместо даты выпуска: 2 года — до 3 лет, 3–4 — от 3 до 5, 5 и больше — старше 5.
  const category = ageYears === null || ageYears >= 5 ? "over5" : ageYears >= 3 ? "from3to5" : "under3";
  const toEur = rates.bynPerUsd / rates.bynPerEur;
  const perCc = (table) => table.find(([top]) => volume <= top)[1];

  const dutyFn = (customsValueUsd) => {
    if (category === "under3") {
      const eur = customsValueUsd * toEur;
      const [, share, rate] = scheme.under3.find(([top]) => eur <= top);

      return Math.max(eur * share, volume * rate) / toEur;
    }

    return (volume * perCc(category === "from3to5" ? scheme.from3to5 : scheme.over5)) / toEur;
  };

  const recyclingByn = category === "under3" ? scheme.recyclingByn.under3 : scheme.recyclingByn.over3;

  return {
    individual: true,
    ageYears,
    ageCategory: category,
    // Граница по модельному году: точная дата выпуска может сдвинуть категорию.
    ageBorderline: ageYears === 3 || ageYears === 5,
    volumeCc: volume,
    dutyFn,
    dutyRate: null,
    exciseRate: 0,
    vatRate: 0,
    vatExempt: true,
    vatAgeBorderline: false,
    recyclingFeeUsd: recyclingByn / rates.bynPerUsd,
    customsFeeUsd: scheme.customsFeeByn / rates.bynPerUsd,
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

/*
 * Сбор аукциона: по таблице (линейно между точками) либо прежней прямой, если ставки заданы
 * вызовом явно. IAAI дороже Copart на фиксированную сумму; неизвестная площадка — как Copart.
 */
const auctionFeeFn = (vehicle, rates, overrides) => {
  const table = rates.auctionFeeTable;

  if (!table || overrides.auctionFeeRate !== undefined || overrides.auctionFeeFixed !== undefined)
    return { fee: price => price * rates.auctionFeeRate + rates.auctionFeeFixed, linear: true };

  const extra = /iaai/i.test(String(vehicle.auction || "")) ? (rates.iaaiFeeExtraUsd || 0) : 0;
  const last = table[table.length - 1];

  const fee = (price) => {
    if (price <= table[0][0])
      return table[0][1] + extra;

    if (price >= last[0])
      return last[1] + (price - last[0]) * rates.auctionFeeTopSlope + extra;

    const index = table.findIndex(([top]) => price <= top);
    const [x1, y1] = table[Math.max(0, index - 1)];
    const [x2, y2] = table[index];

    return y1 + ((price - x1) / (x2 - x1)) * (y2 - y1) + extra;
  };

  return { fee, linear: false };
};

const calculateDeal = (vehicle, overrides = {}) => {
  // Рынок назначения: вызов важнее данных лота; без указания — Беларусь, как всегда.
  const destination = marketOf(overrides.destination || vehicle.destination)?.id || DEFAULT_MARKET;
  const rates = { ...marketOf(destination).rates(), ...overrides };

  /*
   * Поправка точки прогноза для модели, принятая Mikita в «Поправках».
   * Точка, переданная вызовом явно, важнее: так считают «что было бы».
   */
  if (overrides.forecastPosition === undefined) {
    const adjusted = forecastPositions.positionFor(vehicle.model);

    if (adjusted !== null)
      rates.forecastPosition = adjusted;
  }

  /*
   * Требование версии: только страховой продавец. Продавца видно лишь на
   * странице лота, поэтому до расчёта он мог дойти непроверенным — лот
   * от известного нестрахового продавца не получает ни потолка, ни BUY.
   */
  const seller = checkSeller(vehicle.seller);

  if (seller.known && !seller.ok) {
    return {
      lotNumber: vehicle.lotNumber || null,
      maxBidUsd: null,
      viable: false,
      verdict: "SKIP",
      photoStatus: hasPhotoAssessment(vehicle.photoAssessment) ? "ok" : "skipped",
      reason: `Лот не подходит под требования: ${seller.reason}`,
    };
  }

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

  /*
   * Продавец не прочитан — это «неизвестно», а не «разрешено». Проверяем
   * после фотографий и цены: пока их нет, лот и так ждёт, а вот лот
   * со снимками и ценой раньше выходил «Перспективным» с непрочитанным
   * продавцом — так 19.09 прошёл 1-64403346, у которого на странице лота
   * стоит Non-insurance Company.
   */
  // Площадка продавца не публикует (страницу лота прочитали): ждать нечего — оцениваем с пометкой (решение Mikita 09.10).
  if (rates.requireKnownSeller !== false && !seller.known && !seller.unpublished) {
    return {
      lotNumber: vehicle.lotNumber || null,
      maxBidUsd: null,
      viable: false,
      verdict: "PENDING_SELLER",
      photoStatus: hasPhotoAssessment(photo) ? "ok" : "skipped",
      reason: `${seller.reason} — заключение не выдаётся, пока страница лота не покажет, страховая ли компания`,
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

  const individual = destination === "BY" && isIceFuel(vehicle);
  const taxes = destination === "PL"
    ? importTaxesPL(vehicle, rates)
    : individual ? importTaxesBYIndividual(vehicle, rates) : importTaxes(vehicle, rates);

  // Бензин/дизель в Беларуси: пошлина зависит от объёма, без него вердикта нет.
  if (!taxes) {
    return {
      lotNumber: vehicle.lotNumber || null,
      maxBidUsd: null,
      viable: false,
      verdict: "NEEDS_ENGINE_DATA",
      photoStatus: hasPhotoAssessment(photo) ? "ok" : "skipped",
      reason: "Объём двигателя неизвестен — пошлина в Беларуси считается по объёму, расчёт не выдаётся",
    };
  }

  const exciseRate = taxes.exciseRate || 0;
  const resaleValue = marketValue * (1 - rates.resaleDiscount);
  const evSurcharge = isElectric(vehicle) ? rates.evOceanSurchargeUsd : 0;
  /*
   * Логистика по портам (07.10): доставка в порт, море и последний отрезок зависят от штата
   * стоянки. Штата нет в таблице или ставки заданы вызовом явно — прежние общие ставки.
   * Гавайи и Аляска уже включены в таблицу (длинный перегон), доплата тогда не нужна.
   */
  const explicitLogistics = ["usTransportUsd", "oceanFreightUsd", "portToMinskUsd", "inlandTransportUsd"]
    .some(key => overrides[key] !== undefined);
  const logistics = explicitLogistics ? null : logisticsFor({ destination, location: vehicle.location, rates });
  const usTransportUsd = logistics ? logistics.inlandUsd : rates.usTransportUsd;
  const oceanFreightUsd = logistics ? logistics.seaUsd : rates.oceanFreightUsd;

  const remote = logistics ? null : remoteState(vehicle, rates);
  const remoteSurcharge = remote ? rates.remoteLocationSurchargeUsd[remote] : 0;
  // Доставка до границы входит в таможенную стоимость — доплата тоже облагается.
  const inland = logistics ? logistics.landUsd : (rates.inlandTransportUsd ?? rates.portToMinskUsd);
  // Беларусь: перевозка от порта до Минска входит в таможенную стоимость. ЕС: только до порта.
  const inlandInCustoms = rates.inlandInCustomsValue !== false;
  const delivery = usTransportUsd + remoteSurcharge + oceanFreightUsd + evSurcharge
    + (inlandInCustoms ? inland : 0);

  // Всё, что не зависит от цены покупки и не входит в таможенную стоимость.
  const fixedCosts = repairCost + rates.bidcarsFeeUsd + rates.localCostsUsd
    + taxes.recyclingFeeUsd + taxes.customsFeeUsd
    + (inlandInCustoms ? 0 : inland);

  const feeFn = auctionFeeFn(vehicle, rates, overrides);

  const costsAt = (price) => {
    const auctionFees = feeFn.fee(price);
    const customsValue = price + auctionFees + delivery;
    const duty = taxes.dutyFn ? taxes.dutyFn(customsValue) : customsValue * taxes.dutyRate;
    const excise = (customsValue + duty) * exciseRate;
    const vat = (customsValue + duty + excise) * taxes.vatRate;
    const total = customsValue + duty + excise + vat + fixedCosts;

    return { price, auctionFees, customsValue, duty, excise, vat, total, profit: resaleValue - total };
  };

  const taxMultiplier = (1 + taxes.dutyRate) * (1 + exciseRate) * (1 + taxes.vatRate);
  const customsValueAtCeiling = (resaleValue - rates.minProfitUsd - fixedCosts) / taxMultiplier;
  let ceiling = (customsValueAtCeiling - rates.auctionFeeFixed - delivery) / (1 + rates.auctionFeeRate);

  /*
   * Пошлина физлица — максимум из двух линейных выражений со ступенями, поэтому
   * потолок ищем делением пополам: прибыль с ростом цены только убывает.
   */
  // Пошлина физлица и таблица сбора — не линейные: потолок ищем делением пополам.
  if (taxes.dutyFn || !feeFn.linear) {
    if (costsAt(0).profit < rates.minProfitUsd) {
      ceiling = -1;
    } else {
      let lo = 0;
      let hi = Math.max(resaleValue, 1);

      for (let step = 0; step < 60; step += 1) {
        const mid = (lo + hi) / 2;

        if (costsAt(mid).profit >= rates.minProfitUsd)
          lo = mid;
        else
          hi = mid;
      }

      ceiling = lo;
    }
  }

  const forecast = readForecast(vehicle, rates);

  /*
   * Fast Buy (07.10): цена выкупа фиксирована и известна заранее, поэтому
   * прибыль при ней считается отдельно от прогноза торгов. Сборы площадки
   * берём те же, что для торгов, — отдельной ставки для выкупа у нас нет.
   */
  const buyNowUsd = Number(vehicle.buyNowUsd);
  const atFastBuy = Number.isFinite(buyNowUsd) && buyNowUsd > 0
    ? { fastBuyPriceUsd: round(buyNowUsd), atFastBuyUsd: round(costsAt(buyNowUsd).profit) }
    : {};

  const profit = forecast
    ? {
        atMinUsd: round(costsAt(forecast.minUsd).profit),
        atExpectedUsd: round(costsAt(forecast.expectedUsd).profit),
        atMaxUsd: round(costsAt(forecast.maxUsd).profit),
        ...atFastBuy,
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
      usTransportUsd,
      remoteLocationSurchargeUsd: remoteSurcharge,
      oceanFreightUsd,
      evOceanSurchargeUsd: evSurcharge,
      // Беларусь — до Минска, Польша — выгрузка и перевозка по стране (в таможенную стоимость не входит).
      portToMinskUsd: inland,
      inlandTransportUsd: inland,
      bidcarsFeeUsd: rates.bidcarsFeeUsd,
      customsValueUsd: round(at.customsValue),
      customsDutyUsd: round(at.duty),
      exciseUsd: round(at.excise),
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
      destination,
      logistics: logistics
        ? { state: logistics.state, port: logistics.port, route: logistics.route, seaEstimated: logistics.seaEstimated }
        : { source: "default" },
      market: `${marketOf(destination).label}, ввоз компанией`,
      forecastPosition: rates.forecastPosition,
      minProfitUsd: rates.minProfitUsd,
      resaleDiscount: rates.resaleDiscount,
      repairCostBasis: rates.repairCostBasis,
      auctionFee: feeFn.linear ? "linear" : "table",
      auctionFeeRate: rates.auctionFeeRate,
      auctionFeeFixed: rates.auctionFeeFixed,
      usTransportUsd,
      remoteLocation: remote,
      remoteLocationSurchargeUsd: remoteSurcharge,
      oceanFreightUsd,
      portToMinskUsd: inland,
      inlandInCustomsValue: inlandInCustoms,
      bidcarsFeeUsd: rates.bidcarsFeeUsd,
      localCostsUsd: rates.localCostsUsd,
      dutyRate: taxes.dutyRate,
      exciseRate,
      scheme: taxes.individual ? "physical" : "company",
      ...(taxes.individual ? { ageCategory: taxes.ageCategory, ageBorderline: taxes.ageBorderline, volumeCc: taxes.volumeCc } : {}),
      exciseAssumed: taxes.exciseAssumed === true,
      fuelKind: taxes.fuelKind ?? null,
      evDutyFreeQuota: rates.evDutyFreeQuota,
      vatRate: taxes.vatRate,
      vatExempt: taxes.vatExempt,
      vatAgeBorderline: taxes.vatAgeBorderline,
      ageYears: taxes.ageYears,
      bynPerUsd: rates.bynPerUsd,
    },
  };
};

/*
 * Плашки bid.cars и известные запреты не меняют расчёт и вердикт: лот не
 * исключается (решение Mikita 15.09), но несёт предупреждения, а запрет
 * ставки — пометку biddable: false. Добавляются к любому исходу расчёта.
 */
const calculateMaxBid = (vehicle, overrides = {}) => ({
  ...calculateDeal(vehicle, overrides),
  ...lotWarnings(vehicle),
});

module.exports = { calculateMaxBid, importTaxesBYIndividual, auctionFeeFn };
