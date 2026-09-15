const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

const prices = require("./prices");

/*
 * Журнал расходов бэкенда: трафик прокси и разбор фото. Токены ИИ из Dify
 * здесь не пишутся — их Dify хранит сам по каждому прогону.
 *
 * Расход привязывается к прогону Dify, который его вызвал: номер прогона
 * приходит заголовком или в теле запроса и дальше живёт в контексте, так
 * что счётчики внутри поиска и сбора фото знают, чей это расход. Фоновые
 * работы получают свои метки: screener-<день>, bid-watcher.
 */
const context = new AsyncLocalStorage();

const ledgerFile = () => path.join(process.cwd(), "data", "costs.jsonl");

const withRun = (runId, operation) => (runId
  ? context.run({ runId: String(runId) }, operation)
  : operation());

const currentRunId = () => context.getStore()?.runId || null;

const round6 = value => Math.round(value * 1e6) / 1e6;

const perMTok = (tokens, rate) => (Number(tokens) || 0) * rate / 1e6;

const record = (entry) => {
  try {
    const file = ledgerFile();

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({
      at: new Date().toISOString(),
      runId: currentRunId(),
      ...entry,
    })}\n`);
  } catch (error) {
    // Учёт не должен ронять поиск.
    console.error("Журнал расходов не записан:", error.message);
  }
};

const readEntries = ({ runId = null, from = null, to = null } = {}) => {
  try {
    return fs.readFileSync(ledgerFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter(entry => !runId || entry.runId === runId)
      .filter(entry => !from || entry.at >= from)
      .filter(entry => !to || entry.at < to);
  } catch {
    return [];
  }
};

const proxyCostUsd = bytes => round6((bytes / 1024 ** 3) * prices.proxy.usdPerGb);

/*
 * Счётчик трафика одного браузерного контекста. Размеры запросов браузер
 * отдаёт после завершения каждого, поэтому итог собирается перед закрытием.
 */
const meterBrowserContext = (browserContext, { source, viaProxy }) => {
  const pending = [];
  let requests = 0;

  const onFinished = (request) => {
    requests += 1;
    pending.push(request.sizes()
      .then(s => s.requestHeadersSize + s.requestBodySize + s.responseHeadersSize + s.responseBodySize)
      .catch(() => 0));
  };

  browserContext.on("requestfinished", onFinished);

  return {
    async finish() {
      browserContext.off("requestfinished", onFinished);

      const sizes = await Promise.all(pending);
      const bytes = sizes.reduce((sum, size) => sum + Math.max(0, size), 0);

      if (!viaProxy || bytes === 0)
        return { bytes, costUsd: 0 };

      const costUsd = proxyCostUsd(bytes);

      record({ kind: "proxy", source, requests, bytes, costUsd });

      return { bytes, costUsd };
    },
  };
};

/*
 * Разбор фото: сервис возвращает токены и версию модели. Бесплатный тариф —
 * $0, но цена платного сохраняется рядом. Неизвестная модель — цена null.
 */
/*
 * Версия из ответа бывает длиннее ключа прайса («gemini-3.5-flash-lite-preview-…»,
 * «models/…») — берём самый длинный ключ, с которого она начинается.
 */
const visionPrice = (model) => {
  const name = String(model || "").replace(/^models\//, "");

  const key = Object.keys(prices.vision.models)
    .filter(candidate => name === candidate || name.startsWith(`${candidate}-`))
    .sort((a, b) => b.length - a.length)[0];

  return key ? prices.vision.models[key] : null;
};

const recordVision = ({ lotNumber, provider, model, usage }) => {
  const price = visionPrice(model);
  const inputTokens = Number(usage?.inputTokens) || 0;
  const outputTokens = Number(usage?.outputTokens) || 0;

  const paidUsd = price
    ? round6(perMTok(inputTokens, price.inputPerMTok) + perMTok(outputTokens, price.outputPerMTok))
    : null;

  record({
    kind: "vision",
    source: "Разбор фото",
    lotNumber: lotNumber ? String(lotNumber) : null,
    provider: provider || null,
    model: model || null,
    inputTokens,
    outputTokens,
    tier: prices.vision.tier,
    paidEquivalentUsd: paidUsd,
    // На бесплатном тарифе платим ноль и тогда, когда цены модели не знаем.
    costUsd: prices.vision.tier === "free" ? 0 : paidUsd,
    priceKnown: prices.vision.tier === "free" || paidUsd !== null,
    usageReported: Boolean(usage),
  });
};

module.exports = {
  currentRunId,
  meterBrowserContext,
  proxyCostUsd,
  readEntries,
  record,
  recordVision,
  withRun,
};
