const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(
  process.cwd(),
  "data",
  "recommendations-history.json"
);

const readAll = () => {
  try {
    if (!fs.existsSync(HISTORY_FILE))
      return [];

    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("History read error:", error.message);

    return [];
  }
};

const writeAll = (entries) => {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });

  // Пишем через временный файл: если процесс прервётся на записи,
  // накопленная история не превратится в обрезанный файл.
  const tempFile = `${HISTORY_FILE}.tmp`;

  fs.writeFileSync(tempFile, JSON.stringify(entries, null, 2), "utf8");
  fs.renameSync(tempFile, HISTORY_FILE);
};

const appendRun = (records) => {
  if (!records || records.length === 0)
    return [];

  const runId = new Date().toISOString();
  const entries = readAll();

  const added = records.map(record => ({
    runId,
    createdAt: runId,
    ...record,
    actual: null,
  }));

  writeAll([...entries, ...added]);

  return added;
};

/*
 * Факт торгов привязывается к лоту, а не к отдельному прогону:
 * один и тот же лот мог анализироваться несколько раз, и реальная
 * цена продажи у него всё равно одна.
 */
const setActual = (lotNumber, actual) => {
  const target = String(lotNumber);
  const entries = readAll();
  let updated = 0;

  const next = entries.map((entry) => {
    if (String(entry.lotNumber) !== target)
      return entry;

    updated += 1;

    return {
      ...entry,
      actual: {
        soldPriceUsd: actual.soldPriceUsd ?? null,
        soldAt: actual.soldAt || new Date().toISOString(),
        note: actual.note || null,
      },
    };
  });

  if (updated > 0)
    writeAll(next);

  return updated;
};

/*
 * Сводка нужна для главного вопроса: где прогноз разошёлся с торгами.
 *
 * missedOpportunity — ушло дешевле нашего потолка, покупка была возможна.
 * correctlySkipped  — ушло дороже потолка, отказ был оправдан.
 */
const buildSummary = () => {
  const entries = readAll();
  const withActual = entries.filter(
    entry => entry.actual && Number.isFinite(entry.actual.soldPriceUsd)
  );

  const comparisons = withActual
    .filter(entry => Number.isFinite(entry.maxBidUsd))
    .map((entry) => {
      const sold = entry.actual.soldPriceUsd;
      const gap = entry.maxBidUsd - sold;

      return {
        lotNumber: entry.lotNumber,
        vehicle: [entry.year, entry.make, entry.model]
          .filter(Boolean)
          .join(" "),
        decision: entry.decision,
        maxBidUsd: entry.maxBidUsd,
        soldPriceUsd: sold,
        gapUsd: gap,
        gapPct: sold > 0 ? Math.round((gap / sold) * 100) : null,
        outcome: gap >= 0 ? "missedOpportunity" : "correctlySkipped",
        repairCostSource: entry.repairCostSource,
      };
    });

  const deviations = comparisons
    .map(item => Math.abs(item.gapPct))
    .filter(Number.isFinite);

  return {
    totalEntries: entries.length,
    lotsTracked: new Set(entries.map(entry => entry.lotNumber)).size,
    withActualPrice: withActual.length,
    comparisons,
    averageDeviationPct: deviations.length
      ? Math.round(deviations.reduce((a, b) => a + b, 0) / deviations.length)
      : null,
  };
};

module.exports = {
  HISTORY_FILE,
  readAll,
  appendRun,
  setActual,
  buildSummary,
};
