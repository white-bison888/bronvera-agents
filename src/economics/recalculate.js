const defaultHistory = require("../history/store");
const { calculateMaxBid } = require("./max-bid");
const { getVinInfo } = require("../providers/tesla-vin");
const { vinFactsOf } = require("./destination-deals");
const { modelKey } = require("./forecast-positions");
const { pickSeller } = require("../providers/lot-requirements");
const { noticeFields } = require("../providers/lot-notices");

/*
 * Пересчёт открытых лотов модели после поправки точки прогноза (решение
 * Mikita 2026-09-15: применять к новым и открытым). Торги, которые уже
 * прошли, не трогаем — их прогноз сверяется таким, каким был до торгов.
 *
 * Каждый лот получает новую оценку в истории: те же цена в Беларуси,
 * разбор фото и продавец, что в последней оценке, и новая точка прогноза.
 */
const recalculateOpenLots = ({ model, bidCars, photoAssessor, history = defaultHistory, now = Date.now(), reason }) => {
  // Без модели — все открытые лоты (пересчёт после смены ставок, например логистики по портам).
  const key = model ? modelKey(model) : null;
  const byLot = new Map();

  for (const entry of history.readAll()) {
    if (key !== null && modelKey(entry.model) !== key)
      continue;

    const lot = String(entry.lotNumber);
    byLot.set(lot, [...(byLot.get(lot) || []), entry]);
  }

  const records = [];

  for (const [lotNumber, entries] of byLot) {
    const latest = entries[entries.length - 1];
    const listing = bidCars.findByLotNumber(lotNumber);
    const saleDate = listing?.saleDate || latest.saleDate;

    /*
     * Цену в Беларуси берём последнюю известную по лоту, а не из последней
     * записи: запись могла её не содержать (пересчёт без цены, ручной
     * запрос), и тогда лот терял и цену, и вердикт.
     */
    const marketValueUsd = entries
      .map(entry => entry.marketValueUsd)
      .filter(value => Number.isFinite(value))
      .pop();

    // Без реестра нет прогноза Bid.Cars, без цены в Беларуси нечего пересчитывать.
    if (!listing || !Number.isFinite(marketValueUsd) || !saleDate || Date.parse(saleDate) <= now)
      continue;

    const sellers = [listing.seller, ...entries.map(entry => entry.lotDetails?.seller).reverse()];
    const seller = pickSeller(sellers);
    const lotDetails = entries.map(entry => entry.lotDetails).filter(Boolean).pop() || {};
    const photoAssessment = photoAssessor?.getCached?.(lotNumber) || null;

    const result = calculateMaxBid({
      ...listing,
      ...vinFactsOf(getVinInfo().peek(listing.vin || latest.vin)),
      // Место стоянки определяет порт и логистику: в реестре его может не быть, тогда берём из карточки лота.
      location: listing.location || lotDetails.location || latest.location,
      lotNumber,
      ...noticeFields(lotDetails),
      ...(seller ? { seller } : {}),
      marketValueUsd,
      ...(photoAssessment ? { photoAssessment } : {}),
    });

    records.push({
      lotNumber,
      vin: latest.vin,
      make: latest.make,
      model: latest.model,
      year: latest.year,
      url: latest.url,
      primaryDamage: latest.primaryDamage || null,
      saleDate,
      bidAtAnalysisUsd: listing.currentBid ?? null,
      marketValueUsd,
      repairCostUsd: result.breakdown?.repairCostUsd ?? null,
      repairCostSource: result.repairCostSource || null,
      damageType: result.damageType || null,
      maxBidUsd: result.maxBidUsd ?? null,
      viable: result.viable === true,
      forecast: result.forecast || null,
      profit: result.profit || null,
      verdictReason: result.reason || null,
      breakdown: result.breakdown || null,
      assumptions: result.assumptions || null,
      notViableReason: result.viable === false ? result.reason : null,
      photoStatus: result.photoStatus || null,
      photosAnalyzed: result.photosAnalyzed ?? null,
      warnings: result.warnings || [],
      biddable: result.biddable !== false,
      marketReference: latest.marketReference || null,
      decision: result.verdict || latest.decision || null,
      decisionHeld: latest.decisionHeld || null,
      finalScore: latest.finalScore,
      confidence: latest.confidence,
      ...(latest.lotDetails ? { lotDetails: latest.lotDetails } : {}),
      ...(latest.screener ? { screener: latest.screener } : {}),
      recalculatedFor: reason || "forecast-position",
    });
  }

  if (records.length)
    history.appendRun(records);

  return records.map(record => record.lotNumber);
};

module.exports = { recalculateOpenLots };
