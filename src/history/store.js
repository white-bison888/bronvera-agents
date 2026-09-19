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

  /*
   * Итог торгов и вписанные вручную цены аналогов — факты о лоте, а не
   * об отдельной оценке. Повторный анализ после торгов раньше создавал
   * запись без них, и разбор сравнивал с финалом старую оценку.
   *
   * Так же и с датой торгов, повреждением, адресом, характеристиками со
   * страницы лота и прогнозом Bid.Cars: их пишут не все пересчёты, и
   * 16.09 уточнение по фотографиям лишило лот даты торгов на сайте.
   * Новая запись всегда важнее — переносим только то, чего в ней нет.
   */
  const CARRIED = [
    "actual",
    "marketReference",
    // Лот из утреннего отбора остаётся помеченным и после оценки через Dify.
    "screener",
    "saleDate",
    "primaryDamage",
    "url",
    "lotDetails",
    // Диапазон площадки: прогноз BRONVERA без снимков не считается, а он известен.
    "auctionEstimateMin",
    "auctionEstimateMax",
  ];

  const lotFacts = new Map();

  for (const entry of entries) {
    const facts = lotFacts.get(String(entry.lotNumber)) || {};

    for (const field of CARRIED) {
      if (entry[field] !== undefined && entry[field] !== null)
        facts[field] = entry[field];
    }

    // Объявления, из которых посчитана цена в Беларуси: пересчёт после фото их не повторяет.
    if (entry.market)
      facts.market = entry.market;

    lotFacts.set(String(entry.lotNumber), facts);
  }

  const added = records.map((record) => {
    const facts = lotFacts.get(String(record.lotNumber)) || {};

    const carried = {};

    for (const field of CARRIED) {
      const value = record[field] !== undefined && record[field] !== null ? record[field] : facts[field];

      if (value !== undefined && value !== null)
        carried[field] = value;
    }

    // Прежние объявления годятся, только если оценка стоит на той же цене в Беларуси.
    const market = record.market
      || ((facts.market && facts.market.marketValueUsd === record.marketValueUsd) ? facts.market : null);

    return {
      runId,
      createdAt: runId,
      ...record,
      ...carried,
      // Эти два поля сайт и разбор читают всегда — пусть будут даже пустыми.
      marketReference: carried.marketReference || null,
      actual: carried.actual || null,
      ...(market ? { market } : {}),
    };
  });

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
 * Цены живых аналогов, введённые вручную. Они надёжнее пересчёта
 * американской витрины и со временем позволят посчитать поправочный
 * коэффициент по фактам, а не подбирать его на глаз.
 */
const setMarketReference = (lotNumber, reference) => {
  const target = String(lotNumber);
  const entries = readAll();
  let updated = 0;

  const next = entries.map((entry) => {
    if (String(entry.lotNumber) !== target)
      return entry;

    updated += 1;

    return {
      ...entry,
      marketReference: {
        ...(entry.marketReference || {}),
        ...(Number.isFinite(reference.polandPriceUsd)
          ? {
              polandPriceUsd: reference.polandPriceUsd,
              ...(reference.polandPriceUsd !== entry.marketReference?.polandPriceUsd
                ? { polandSourceUrl: null, polandObservedOn: null } : {}),
            }
          : {}),
        ...(reference.polandSourceUrl !== undefined
          ? { polandSourceUrl: reference.polandSourceUrl, polandObservedOn: reference.polandObservedOn } : {}),
        ...(Number.isFinite(reference.belarusPriceUsd)
          ? { belarusPriceUsd: reference.belarusPriceUsd }
          : {}),
        updatedAt: new Date().toISOString(),
      },
    };
  });

  if (updated > 0)
    writeAll(next);

  return updated;
};

/*
 * Дату торгов переносят, и записанная при анализе быстро врёт. Карточка
 * читает её отсюда, а не из реестра лотов, поэтому обновлять нужно здесь —
 * иначе в интерфейсе навсегда остаётся «торги прошли».
 */
const setSaleDate = (lotNumber, saleDate) => {
  const target = String(lotNumber);
  const entries = readAll();
  let updated = 0;

  const next = entries.map((entry) => {
    if (String(entry.lotNumber) !== target || entry.saleDate === saleDate)
      return entry;

    updated += 1;

    return { ...entry, saleDate, saleDateCheckedAt: new Date().toISOString() };
  });

  if (updated > 0)
    writeAll(next);

  return updated;
};

/*
 * Характеристики со страницы лота: продавец, ключ, цвет, дата торгов и
 * прочее, чего нет в карточке каталога. Пишутся один раз за визит —
 * повторно ходить на страницу нельзя, площадка блокирует.
 */
const setLotDetails = (lotNumber, details) => {
  const target = String(lotNumber);
  const entries = readAll();
  let updated = 0;

  const next = entries.map((entry) => {
    if (String(entry.lotNumber) !== target)
      return entry;

    updated += 1;

    return {
      ...entry,
      lotDetails: {
        ...(entry.lotDetails || {}),
        ...details,
        updatedAt: new Date().toISOString(),
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

  /*
   * Лот в разборе представляет одна оценка — самая свежая. Повторный анализ
   * дописывает в историю ещё одну запись того же лота, и без этого лот,
   * который прогоняли пять раз, весил бы в средних впятеро больше остальных.
   *
   * Свежая, а не «последняя до торгов» — выбор владельца (2026-09-13).
   * Анализ, запущенный уже после торгов, заменит собой оценку, по которой
   * решалась бы ставка.
   */
  const latestByLot = new Map();
  const estimatesByLot = new Map();

  for (const entry of withActual) {
    const lot = String(entry.lotNumber);
    const current = latestByLot.get(lot);

    estimatesByLot.set(lot, (estimatesByLot.get(lot) || 0) + 1);

    // При равном времени побеждает запись, дописанная в историю позже.
    if (!current || (entry.createdAt || "") >= (current.createdAt || ""))
      latestByLot.set(lot, entry);
  }

  /*
   * Свежая оценка без потолка (ждём фото, нет цены рынка) не уступает
   * место старой: иначе в разбор возвращается потолок, посчитанный по
   * устаревшим данным, и искажает перекос. У такого лота прогноза нет.
   */
  const comparisons = [...latestByLot.values()]
    .filter(entry => Number.isFinite(entry.maxBidUsd))
    .map((entry) => {
      const sold = entry.actual.soldPriceUsd;
      const gap = entry.maxBidUsd - sold;

      return {
        lotNumber: entry.lotNumber,
        vehicle: [entry.year, entry.make, entry.model]
          .filter(Boolean)
          .join(" "),
        url: entry.url || null,
        decision: entry.decision,
        maxBidUsd: entry.maxBidUsd,
        soldPriceUsd: sold,
        gapUsd: gap,
        gapPct: sold > 0 ? Math.round((gap / sold) * 100) : null,
        outcome: gap >= 0 ? "missedOpportunity" : "correctlySkipped",
        /*
         * Потолок ноль означает «не окупается ни при какой цене». Разрыв
         * у такого лота всегда −100% и промахом прогноза не является:
         * в среднем он утягивает перекос вниз и создаёт впечатление,
         * будто формула осторожничает, хотя лот просто отвергнут.
         */
        viable: entry.viable === true && entry.maxBidUsd > 0,
        repairCostSource: entry.repairCostSource,
        repairCostUsd: entry.repairCostUsd ?? null,
        damageType: entry.damageType || null,
        photoStatus: entry.photoStatus || null,
        // Цену торгов могли вписать руками, а могли снять с площадки.
        actualSource: entry.actual.note || null,
        estimatedAt: entry.createdAt || null,
        // Сколько раз лот оценивали; в расчёт идёт только последняя оценка.
        estimatesCount: estimatesByLot.get(String(entry.lotNumber)),
      };
    })
    // Крупные расхождения важнее: с них начинают разбор.
    .sort((a, b) => Math.abs(b.gapUsd) - Math.abs(a.gapUsd));

  /*
   * Разрез нужен для настройки формулы: систематический перекос в одну
   * сторону у конкретного источника оценки ремонта или типа повреждения
   * означает, что ошибается не отдельный лот, а само правило.
   *
   * Знак важен не меньше величины: стабильный плюс — потолок щедрый,
   * стабильный минус — слишком осторожный. Среднее по модулю их бы
   * смешало и показало «всё одинаково плохо».
   */
  // Считаем только по лотам с рассчитанным потолком: отвергнутые
  // «не окупается» искажают любое среднее.
  const forecast = comparisons.filter(item => item.viable);

  const groupBy = (field) => {
    const groups = {};

    for (const item of forecast) {
      const key = item[field] || "не указан";

      (groups[key] = groups[key] || []).push(item);
    }

    return Object.entries(groups)
      .map(([key, items]) => {
        const pcts = items.map(i => i.gapPct).filter(Number.isFinite);
        const sum = pcts.reduce((a, b) => a + b, 0);

        return {
          key,
          count: items.length,
          avgGapPct: pcts.length ? Math.round(sum / pcts.length) : null,
          avgAbsGapPct: pcts.length
            ? Math.round(pcts.reduce((a, b) => a + Math.abs(b), 0) / pcts.length)
            : null,
          missed: items.filter(i => i.outcome === "missedOpportunity").length,
        };
      })
      .sort((a, b) => b.count - a.count);
  };

  const deviations = forecast
    .map(item => Math.abs(item.gapPct))
    .filter(Number.isFinite);

  const signed = forecast.map(item => item.gapPct).filter(Number.isFinite);

  return {
    totalEntries: entries.length,
    lotsTracked: new Set(entries.map(entry => entry.lotNumber)).size,
    // Лоты, а не записи: оба экрана подписывают это число как «лотов».
    withActualPrice: new Set(withActual.map(entry => String(entry.lotNumber))).size,
    // Сколько лотов реально участвует в оценке прогноза.
    forecastCount: forecast.length,
    notViableCount: comparisons.length - forecast.length,
    comparisons,
    averageDeviationPct: deviations.length
      ? Math.round(deviations.reduce((a, b) => a + b, 0) / deviations.length)
      : null,
    // Со знаком: показывает не «насколько мажем», а «в какую сторону».
    averageBiasPct: signed.length
      ? Math.round(signed.reduce((a, b) => a + b, 0) / signed.length)
      : null,
    byRepairSource: groupBy("repairCostSource"),
    byDamageType: groupBy("damageType"),
  };
};

module.exports = {
  HISTORY_FILE,
  readAll,
  appendRun,
  setActual,
  setMarketReference,
  setLotDetails,
  setSaleDate,
  buildSummary,
};
