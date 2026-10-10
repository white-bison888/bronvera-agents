const { calculateMaxBid } = require("../economics/max-bid");
const { trimHintOf, vinFactsOf } = require("../economics/destination-deals");
const { marketSnapshot } = require("../market/minsk-prices");
const { applyExtraFilters, hasExtraFilters, sellerFromSources } = require("./extra-filters");

/*
 * Быстрый поиск без ИИ (прототип, 07.10.2026): тот же путь, что у утреннего отбора,
 * только по запросу пользователя. Поиск лотов на bid.cars → расшифровка VIN → цена в
 * Беларуси → расчёт по формуле → запись в историю и очередь фото. Нейросеть не нужна:
 * вердикт, потолок и выгоду и раньше считала формула, а не ИИ.
 *
 * Лоты без разбора фото получают «ждём фото» — как и в основном поиске: заключения по
 * тексту объявления мы не выдаём. Фото собирает очередь, после чего оценка пересчитывается.
 */
const PRICE_PAUSE_MS = 0;

const record = ({ lot, market, result, filters, jobId, now }) => ({
  lotNumber: String(lot.lotNumber),
  vin: lot.vin || null,
  make: lot.make || null,
  model: lot.model || null,
  year: lot.year || null,
  url: lot.url || null,
  primaryDamage: lot.primaryDamage || null,
  saleDate: lot.saleDate || null,
  bidAtAnalysisUsd: lot.currentBid ?? null,
  marketValueUsd: market?.marketValueUsd ?? null,
  ...(market && market.status === "ok" ? { market: marketSnapshot(market) } : {}),
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
  decision: result.verdict || null,
  decisionHeld: null,
  // Откуда запись: поиск по форме, а не по запросу в Dify — по этой метке сравниваем два поиска.
  quickSearch: { jobId, at: now.toISOString(), filters },
});

/*
 * deps: searchCars, vinInfo, marketPrices, photoAssessor, history, photoQueue,
 * report(step, detail) — для строки прогресса на сайте.
 */
const runQuickSearch = async ({ filters, deps, jobId = "manual", now = () => new Date(), report = () => {} }) => {
  report("search", "Ищу лоты на bid.cars");

  const wanted = filters.maxResults || 10;
  const extra = hasExtraFilters(filters);

  // Дополнительные фильтры работают после поиска, поэтому просим у реестра лотов с запасом.
  const found = await deps.searchCars(extra ? { ...filters, maxResults: Math.min(80, Math.max(wanted * 4, 40)) } : filters);
  let pool = Array.isArray(found.listings) ? found.listings : [];
  let dropped = null;

  if (extra) {
    const sellers = new Map();

    for (const entry of deps.history.readAll?.() || []) {
      if (entry.lotDetails?.seller)
        sellers.set(String(entry.lotNumber), entry.lotDetails.seller);
    }

    ({ lots: pool, dropped } = applyExtraFilters(pool, filters, {
      sellerOf: lot => sellerFromSources(lot, sellers.get(String(lot.lotNumber))),
    }));
  }

  const listings = pool.slice(0, wanted);
  const stats = {
    droppedByFilters: dropped,
    found: listings.length,
    message: found.meta?.message || null,
    withPrice: 0,
    noPrice: 0,
    photosQueued: 0,
    withVerdict: 0,
  };

  if (!listings.length)
    return { lots: [], stats, filters };

  report("vin", `Расшифровываю VIN: ${listings.length} лотов`);
  await deps.vinInfo.ensure(listings.map(lot => lot.vin));

  const records = [];
  const toQueue = [];

  for (let index = 0; index < listings.length; index += 1) {
    const lot = listings[index];

    report("prices", `Цены и расчёт: ${index + 1} из ${listings.length}`);

    const info = deps.vinInfo.peek(lot.vin);
    const market = await deps.marketPrices.lookup({
      lotNumber: lot.lotNumber,
      make: lot.make,
      model: lot.model,
      year: lot.year,
      mileage: lot.mileage,
      vin: lot.vin,
      trimHint: trimHintOf(info),
    });

    const photoAssessment = deps.photoAssessor.getCached(lot.lotNumber) || null;
    const result = calculateMaxBid({
      ...lot,
      ...vinFactsOf(info),
      marketValueUsd: market.marketValueUsd,
      ...(photoAssessment ? { photoAssessment } : {}),
    });

    if (market.marketValueUsd)
      stats.withPrice += 1;
    else
      stats.noPrice += 1;

    if (["BUY", "WATCH", "SKIP"].includes(result.verdict))
      stats.withVerdict += 1;

    /*
     * Фото разбираются по одному раз в четыре минуты, а быстрый поиск ставит в очередь все найденные лоты,
     * поэтому порядок важен: впереди те, что выгоднее по формуле без фото. Заключения это не заменяет —
     * только решает, чей разбор начнётся первым.
     */
    const rough = photoAssessment
      ? null
      : calculateMaxBid({ ...lot, ...vinFactsOf(info), marketValueUsd: market.marketValueUsd }, { requirePhotoAssessment: false, requireKnownSeller: false });

    if (!photoAssessment)
      toQueue.push({ lotNumber: lot.lotNumber, rough: rough?.profit?.atExpectedUsd ?? -Infinity });

    records.push(record({ lot, market, result, filters, jobId, now: now() }));

    if (PRICE_PAUSE_MS)
      await new Promise(resolve => setTimeout(resolve, PRICE_PAUSE_MS));
  }

  report("save", "Записываю в «Прогнозы»");

  deps.history.appendRun(records);

  if (toQueue.length) {
    const ordered = toQueue.sort((a, b) => b.rough - a.rough).map(({ lotNumber }) => ({ lotNumber }));

    stats.photosQueued = deps.photoQueue.enqueue(ordered, `quick-${jobId}`) ?? ordered.length;
  }

  return { lots: records.map(item => item.lotNumber), stats, filters };
};

module.exports = { record, runQuickSearch };
