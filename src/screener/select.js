const defaultRates = require("../economics/rates");
const { calculateMaxBid } = require("../economics/max-bid");
const { checkSeller, isRunAndDrive } = require("../providers/lot-requirements");
const { auctionWindow } = require("../providers/auction-window");

/*
 * Признаки отбора. Повреждения — любые, кроме затопления и пожара (выбор
 * Mikita 15.09): после них электромобиль почти всегда уходит в разбор
 * батареи, и прогноз ремонта ничего не значит.
 */
const EXCLUDED_DAMAGE = [
  { reason: "затопление", pattern: /flood|water|zalan|powód|powodz/i },
  { reason: "пожар", pattern: /burn|fire|pożar|pozar|spalon/i },
];

/*
 * Документ, с которым машину уже не поставить на учёт: сертификат
 * уничтожения, «только на запчасти». Такие лоты США не выпускает на
 * экспорт как автомобиль.
 */
const EXCLUDED_TITLE = /destruction|junk|non-?repairable|parts\s*only|dismantl|scrap|crush/i;

const HOUR_MS = 3600000;

const minskDay = date => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Minsk",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(date);

const minskHour = date => Number(new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Minsk",
  hour: "2-digit",
  hourCycle: "h23",
}).format(date));

const normalizeStartCode = value => (/run\s*(\/|and)\s*drive/i.test(String(value || ""))
  ? "run_and_drive"
  : "other");

const expectedPriceUsd = (lot, rates = defaultRates) => {
  const min = Number(lot.auctionEstimateMin);
  const max = Number(lot.auctionEstimateMax);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min)
    return null;

  return Math.round(min + rates.forecastPosition * (max - min));
};

/*
 * Быстрая проверка по данным выдачи, без цены рынка и расчёта.
 * Возвращает причину отказа или null, если лот идёт дальше.
 */
const prefilterReason = (lot, { now, config, rates = defaultRates }) => {
  if (auctionWindow(lot, now).over)
    return "торги прошли";

  if (!isRunAndDrive(normalizeStartCode(lot.runAndDrive)))
    return "не Run and Drive";

  const seller = checkSeller(lot.seller);

  if (seller.known && !seller.ok)
    return "продавец не страховая";

  const damageText = [lot.primaryDamage, lot.secondaryDamage].filter(Boolean).join(" ");
  const damage = EXCLUDED_DAMAGE.find(item => item.pattern.test(damageText));

  if (damage)
    return damage.reason;

  if (EXCLUDED_TITLE.test(String(lot.titleDocument || lot.titleType || "")))
    return "документ без права регистрации";

  const saleTime = lot.saleDate ? new Date(lot.saleDate).getTime() : NaN;

  if (!Number.isFinite(saleTime))
    return "нет даты торгов";

  const hoursLeft = (saleTime - now.getTime()) / HOUR_MS;

  if (hoursLeft < config.minHoursBeforeAuction)
    return "торги слишком скоро — фото не успеть";

  if (hoursLeft > config.maxHoursBeforeAuction)
    return "торги позже 48 часов — в следующий скан";

  const expected = expectedPriceUsd(lot, rates);

  if (expected === null)
    return "нет прогноза bid.cars";

  const ceiling = Math.max(...config.tiers.map(tier => tier.maxExpectedPriceUsd));

  if (expected > ceiling)
    return `прогноз выше $${ceiling}`;

  return null;
};

/*
 * Сделка без фото: ремонт по нормативу типа повреждения (или по разбору
 * снимков, если он уже есть). Это не вердикт — только очередь на разбор.
 */
const evaluateLot = (lot, { market, photoAssessment = null, rates = {} }) => {
  const result = calculateMaxBid(
    {
      ...lot,
      marketValueUsd: market.marketValueUsd,
      ...(photoAssessment ? { photoAssessment } : {}),
    },
    { ...rates, requirePhotoAssessment: false }
  );

  if (!result.profit || !result.breakdown)
    return { result, repairRoomUsd: null, profitAtExpectedUsd: null };

  const { minProfitUsd } = { ...defaultRates, ...rates };

  return {
    result,
    expectedPriceUsd: result.forecast.expectedUsd,
    profitAtExpectedUsd: result.profit.atExpectedUsd,
    repairCostUsd: result.breakdown.repairCostUsd,
    repairSource: result.repairCostSource,
    damageType: result.damageType,
    // Прибыль посчитана за вычетом ремонта, но без порога: возвращаем ремонт
    // и вычитаем порог — остаётся бюджет на ремонт при прибыли от порога.
    repairRoomUsd: Math.round(result.profit.atExpectedUsd + result.breakdown.repairCostUsd - minProfitUsd),
    priceToMarketPct: Math.round((result.forecast.expectedUsd / market.marketValueUsd) * 100),
  };
};

/*
 * Порядок внутри списка: ожидаемая прибыль с ремонтом по нормативу —
 * так мелкие повреждения поднимаются выше лобовых при той же цене.
 * При равной прибыли выше тот, у кого больше запас на ремонт.
 */
const rankTiers = (evaluated, config) => config.tiers.map((tier) => {
  const candidates = evaluated
    .filter(item => item.expectedPriceUsd <= tier.maxExpectedPriceUsd)
    .filter(item => item.repairRoomUsd >= config.minRepairRoomUsd)
    .sort((a, b) => (b.profitAtExpectedUsd - a.profitAtExpectedUsd)
      || (b.repairRoomUsd - a.repairRoomUsd))
    .slice(0, tier.maxCandidates)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return { ...tier, candidates };
});

const countBy = (items) => {
  const counts = {};

  for (const item of items)
    counts[item] = (counts[item] || 0) + 1;

  return counts;
};

module.exports = {
  EXCLUDED_DAMAGE,
  EXCLUDED_TITLE,
  countBy,
  evaluateLot,
  expectedPriceUsd,
  minskDay,
  minskHour,
  prefilterReason,
  rankTiers,
};
