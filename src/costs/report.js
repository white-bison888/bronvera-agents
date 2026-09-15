const defaultPrices = require("./prices");

/*
 * Стоимость поиска и итоги периода из трёх источников: токены шагов Dify,
 * журнал бэкенда (прокси, разбор фото) и постоянные счета. Каждая строка
 * отчёта говорит, известна ли её цена: неизвестное не складывается в итог
 * молча, а перечисляется отдельно.
 */

const round = value => Math.round(value * 1e6) / 1e6;
const sum = values => round(values.reduce((total, value) => total + (Number(value) || 0), 0));

const MINSK_OFFSET_MS = 3 * 3600000;

const minskDay = date => new Date(date.getTime() + MINSK_OFFSET_MS).toISOString().slice(0, 10);

// Дата Dify без пояса — это UTC.
const difyDate = value => (value ? new Date(/Z$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`) : null);

const daysInMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

const fixedMonthlyUsd = (item, prices) => {
  if (Number.isFinite(item.usd))
    return item.usd;

  if (Number.isFinite(item.eur))
    return round(item.eur * prices.eurUsd.rate);

  return null;
};

const formatTokens = value => Number(value || 0).toLocaleString("ru-RU").replace(/ /g, " ");

// Суммы в пояснениях — как на сайте: запятая, центы и доли цента.
const formatUsd = (value) => {
  const abs = Math.abs(value);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;

  return `$${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
};

const formatMb = bytes => (bytes / 1024 ** 2).toLocaleString("ru-RU", { maximumFractionDigits: 1 });

/*
 * Шаг ИИ: цена по нашему прайсу. Dify считает свою — если разошлись,
 * значит поменялась модель или прайс, и это видно в строке.
 */
const llmItem = (node, prices) => {
  const usage = node.usage || null;
  const price = node.model ? prices.llm.models[node.model] : null;
  const input = Number(usage?.prompt_tokens) || 0;
  const output = Number(usage?.completion_tokens) || 0;

  if (!usage) {
    return {
      group: "ИИ в Dify",
      label: node.title,
      detail: node.status === "failed" ? "шаг упал до ответа модели — токены не списаны" : "нет данных о токенах",
      costUsd: 0,
      known: true,
    };
  }

  const costUsd = price
    ? round(input * price.inputPerMTok / 1e6 + output * price.outputPerMTok / 1e6)
    : null;

  const difyUsd = Number(usage.total_price);
  const mismatch = costUsd !== null && Number.isFinite(difyUsd) && Math.abs(difyUsd - costUsd) > Math.max(0.0005, costUsd * 0.02);

  return {
    group: "ИИ в Dify",
    label: node.title,
    detail: `${node.model || "модель не указана"} · ${formatTokens(input)} вход / ${formatTokens(output)} выход`
      + (mismatch ? ` · Dify насчитал ${formatUsd(difyUsd)} — сверить прайс` : ""),
    tokens: input + output,
    costUsd,
    known: costUsd !== null,
  };
};

const ledgerItems = (entries) => {
  const items = [];

  const proxy = entries.filter(entry => entry.kind === "proxy");

  if (proxy.length) {
    const bytes = sum(proxy.map(entry => entry.bytes));
    const sources = [...new Set(proxy.map(entry => entry.source))].join(", ");

    items.push({
      group: "Прокси",
      label: "Трафик bid.cars через DataImpulse",
      detail: `${formatMb(bytes)} МБ · ${sources} · ≈ по объёму запросов`,
      costUsd: sum(proxy.map(entry => entry.costUsd)),
      known: true,
    });
  }

  const vision = entries.filter(entry => entry.kind === "vision");

  if (vision.length) {
    const tokens = sum(vision.map(entry => (entry.inputTokens || 0) + (entry.outputTokens || 0)));
    const models = [...new Set(vision.map(entry => entry.model).filter(Boolean))].join(", ") || "модель не указана";
    const paid = vision.map(entry => entry.paidEquivalentUsd);
    const free = vision.every(entry => entry.tier === "free");
    const unreported = vision.filter(entry => !entry.usageReported).length;

    items.push({
      group: "Разбор фото",
      label: `Gemini · лотов: ${vision.length}`,
      detail: `${models} · ${formatTokens(tokens)} токенов`
        + (free
          ? ` · бесплатный тариф${paid.every(Number.isFinite) ? ` (на платном ${formatUsd(sum(paid))})` : ""}`
          : "")
        + (unreported ? ` · у ${unreported} расход не передан` : ""),
      costUsd: vision.every(entry => entry.priceKnown) ? sum(vision.map(entry => entry.costUsd)) : null,
      known: vision.every(entry => entry.priceKnown),
    });
  }

  return items;
};

// Без базы Dify самая дорогая часть поиска не видна — это не ноль.
const difyUnavailable = () => ({
  group: "ИИ в Dify",
  label: "Шаги ИИ",
  detail: "база Dify недоступна — токены не прочитаны",
  costUsd: null,
  known: false,
});

const freeItems = prices => prices.free.map(item => ({
  group: "Бесплатно",
  label: item.label,
  detail: null,
  costUsd: 0,
  known: true,
}));

const totals = (items) => {
  const unknown = items.filter(item => !item.known).map(item => item.label);

  return {
    totalUsd: sum(items.filter(item => item.known).map(item => item.costUsd)),
    unknown,
  };
};

/*
 * Один поиск: шаги ИИ его прогона, расходы бэкенда с его номером и доля
 * постоянных счетов за время его работы. pendingPhotos — лоты этого поиска,
 * которые ещё ждут разбора фото: сумма потом дополнится.
 */
const buildRunCost = ({ runId, dify, entries = [], pendingPhotos = 0, prices = defaultPrices }) => {
  const run = dify?.run || null;
  const started = difyDate(run?.created_at);
  const durationSec = Number(run?.elapsed_time) || 0;

  const items = [
    ...(dify ? dify.nodes || [] : []).map(node => llmItem(node, prices)),
    ...(dify ? [] : [difyUnavailable()]),
    ...ledgerItems(entries),
  ];

  if (started && durationSec > 0) {
    const secondsInMonth = daysInMonth(started.getUTCFullYear(), started.getUTCMonth()) * 86400;

    for (const fixed of prices.fixedMonthly) {
      const monthly = fixedMonthlyUsd(fixed, prices);
      const minutes = Math.floor(durationSec / 60);
      const seconds = Math.round(durationSec % 60);

      items.push({
        group: "Постоянные счета",
        label: fixed.label,
        detail: `доля за ${minutes ? `${minutes} мин ` : ""}${seconds} с`
          + (monthly === null ? " · тариф не проверен" : ` из ${formatUsd(monthly)} в месяц`),
        costUsd: monthly === null ? null : round(monthly * durationSec / secondsInMonth),
        known: monthly !== null,
      });
    }
  }

  items.push(...freeItems(prices));

  return {
    runId,
    found: Boolean(run),
    status: run?.status || null,
    startedAt: started ? started.toISOString() : null,
    durationSec: Math.round(durationSec),
    items,
    ...totals(items),
    pendingPhotos,
    currency: "USD",
    pricesVerifiedOn: prices.verifiedOn,
    difyAvailable: Boolean(dify),
  };
};

/*
 * Границы дня и месяца — по Минску, в UTC для запросов.
 */
const periodBounds = (type, day) => {
  const [year, month, date] = day.split("-").map(Number);

  const startUtc = type === "month"
    ? Date.UTC(year, month - 1, 1) - MINSK_OFFSET_MS
    : Date.UTC(year, month - 1, date) - MINSK_OFFSET_MS;

  const endUtc = type === "month"
    ? Date.UTC(year, month, 1) - MINSK_OFFSET_MS
    : startUtc + 86400000;

  return {
    type,
    label: type === "month" ? day.slice(0, 7) : day,
    from: new Date(startUtc).toISOString(),
    to: new Date(endUtc).toISOString(),
    days: daysInMonth(year, month - 1),
  };
};

/*
 * Итог периода: ИИ по шагам, фото и прокси по источникам (поиски, утренний
 * отбор, слежение за ставками), постоянные счета — доля дня или весь месяц.
 */
const buildPeriodSummary = ({ period, dify, entries = [], prices = defaultPrices }) => {
  const nodes = dify?.nodes || [];
  const runs = dify?.runs || [];

  const byStep = new Map();

  for (const node of nodes) {
    const item = llmItem(node, prices);
    const current = byStep.get(node.title) || { label: node.title, runs: 0, tokens: 0, costUsd: 0, known: true };

    current.runs += 1;
    current.tokens += item.tokens || 0;
    current.costUsd = round(current.costUsd + (item.costUsd || 0));
    current.known = current.known && item.known;
    byStep.set(node.title, current);
  }

  const sourceOf = (entry) => {
    if (String(entry.runId || "").startsWith("screener-"))
      return "Утренний отбор";

    if (entry.runId === "bid-watcher")
      return "Слежение за ставками";

    return entry.runId ? "Поиски" : "Прочее без привязки";
  };

  const groupsBySource = new Map();

  for (const entry of entries) {
    const key = sourceOf(entry);

    groupsBySource.set(key, [...(groupsBySource.get(key) || []), entry]);
  }

  const backend = [...groupsBySource.entries()].flatMap(([source, list]) =>
    ledgerItems(list).map(item => ({ ...item, label: `${item.label} — ${source}` })));

  const steps = [...byStep.values()].sort((a, b) => b.costUsd - a.costUsd);

  const llm = {
    group: "ИИ в Dify",
    label: `Шаги ИИ · прогонов: ${runs.length}`,
    detail: `${formatTokens(sum(steps.map(step => step.tokens)))} токенов`,
    costUsd: sum(steps.map(step => step.costUsd)),
    known: steps.every(step => step.known),
    steps,
  };

  const fixed = prices.fixedMonthly.map((item) => {
    const monthly = fixedMonthlyUsd(item, prices);

    return {
      group: "Постоянные счета",
      label: item.label,
      detail: monthly === null
        ? "тариф не проверен"
        : period.type === "month" ? `${formatUsd(monthly)} в месяц` : `${formatUsd(monthly)} ÷ ${period.days} дн.`,
      costUsd: monthly === null ? null : round(period.type === "month" ? monthly : monthly / period.days),
      known: monthly !== null,
    };
  });

  const items = [dify ? llm : difyUnavailable(), ...backend, ...fixed];

  return {
    period,
    searches: runs.length,
    items,
    ...totals(items),
    currency: "USD",
    pricesVerifiedOn: prices.verifiedOn,
    difyAvailable: Boolean(dify),
  };
};

module.exports = {
  buildPeriodSummary,
  buildRunCost,
  minskDay,
  periodBounds,
};
