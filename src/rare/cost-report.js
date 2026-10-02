const costLedger = require("../costs/ledger");
const { minskDay } = require("../costs/report");

/*
 * Сводка расходов BRONVERA Rare — отдельно от src/costs/report.js
 * (тот завязан на прогоны Dify, здесь их нет совсем). Платит только
 * резидентный прокси для площадок за Cloudflare (PCARMARKET, Cars & Bids,
 * Collecting Cars) — записи уже пишет costLedger.meterBrowserContext при
 * каждом прогоне их скраперов. Остальные источники (BaT, RM Sotheby's,
 * Hemmings) прокси не используют — честный $0, а не отсутствие строки.
 *
 * Источник, подключённый через прокси, но не добавленный сюда, молча
 * показал бы честный $0 вместо настоящего расхода — проверено на
 * Collecting Cars 02.10.2026 (забыли добавить при подключении).
 */

const round = value => Math.round(value * 1e6) / 1e6;

// Метка в журнале -> id источника Rare. Источников без записи в карте (и без записи в журнале) просто нет в проекте.
const SOURCE_BY_LEDGER_LABEL = {
  "выдача PCARMARKET": "pcarmarket",
  "выдача Cars & Bids": "cars-and-bids",
  "выдача Collecting Cars": "collecting-cars",
};

const lastNDays = (count, now) => {
  const days = [];
  for (let i = count - 1; i >= 0; i -= 1)
    days.push(minskDay(new Date(now - i * 86400000)));
  return days;
};

const bySourceTotals = (sourceIds, byDay, days) => {
  const totals = new Map(sourceIds.map(id => [id, 0]));

  for (const day of days) {
    const perSource = byDay.get(day);
    if (!perSource)
      continue;
    for (const [id, cost] of perSource)
      totals.set(id, round((totals.get(id) || 0) + cost));
  }

  return sourceIds.map(id => ({ id, costUsd: totals.get(id) || 0 }));
};

const sumUsd = items => round(items.reduce((sum, item) => sum + item.costUsd, 0));

/*
 * sourceIds — все источники Rare (не только те, что платят за прокси),
 * чтобы в сводке честно было видно «$0» у бесплатных, а не их отсутствие.
 */
const buildRareCostSummary = ({ sourceIds, entries = costLedger.readEntries(), now = Date.now() }) => {
  const proxyEntries = entries.filter(entry => entry.kind === "proxy" && SOURCE_BY_LEDGER_LABEL[entry.source]);

  const byDay = new Map(); // день (Минск) -> Map(sourceId -> costUsd)

  for (const entry of proxyEntries) {
    const day = minskDay(new Date(entry.at));
    const sourceId = SOURCE_BY_LEDGER_LABEL[entry.source];
    const perSource = byDay.get(day) || new Map();

    perSource.set(sourceId, round((perSource.get(sourceId) || 0) + entry.costUsd));
    byDay.set(day, perSource);
  }

  const last30 = lastNDays(30, now);
  const last7 = last30.slice(-7);
  const today = last30.slice(-1);

  const periodOf = days => {
    const bySource = bySourceTotals(sourceIds, byDay, days);
    return { totalUsd: sumUsd(bySource), bySource };
  };

  const daily = last30.map((day) => {
    const bySource = bySourceTotals(sourceIds, byDay, [day]);
    return { date: day, totalUsd: sumUsd(bySource), bySource };
  });

  return {
    today: { date: today[0], ...periodOf(today) },
    last7Days: { ...periodOf(last7) },
    last30Days: { ...periodOf(last30) },
    daily,
    currency: "USD",
  };
};

module.exports = { buildRareCostSummary };
