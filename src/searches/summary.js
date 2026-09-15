/*
 * ИСТОРИЯ ПОИСКОВ
 *
 * Поиск с сайта — это прогон Dify. По его входу и выходу собираем строку
 * истории: что спросили, чем кончилось и сколько лотов с каким решением.
 * Полный результат сайт берёт из самого прогона по номеру.
 */

const parseJson = (value) => {
  if (!value || typeof value !== "string")
    return value && typeof value === "object" ? value : null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

// Ответ модели бывает обёрнут в <think> и ```json — достаём первый объект.
const parseLooseJson = (text) => {
  const direct = parseJson(text);

  if (direct)
    return direct;

  const cleaned = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  return start >= 0 && end > start ? parseJson(cleaned.slice(start, end + 1)) : null;
};

const summarizeRun = (run) => {
  const inputs = parseJson(run.inputs) || {};
  const outputs = parseJson(run.outputs) || {};
  const base = {
    runId: run.id,
    query: String(inputs.user_request || "").trim(),
    createdAt: run.created_at ? `${String(run.created_at).replace(" ", "T")}Z` : null,
    status: run.status,
    elapsedSec: Math.round(Number(run.elapsed_time) || 0),
  };

  if (run.status === "running")
    return { ...base, outcome: "running", count: 0 };

  if (run.status === "failed" || run.status === "stopped")
    return { ...base, outcome: "error", count: 0, message: run.error || null };

  // Уточнитель остановил поиск до дорогих шагов: причины и переформулировки.
  const clarification = parseLooseJson(outputs.clarification);

  if (clarification)
    return { ...base, outcome: "clarify", count: 0, message: clarification.summary || null };

  const maxBids = parseJson(outputs.max_bid);
  const results = Array.isArray(maxBids?.results) ? maxBids.results : null;

  if (results) {
    const verdicts = {};

    for (const item of results) {
      const verdict = item.verdict || "NONE";
      verdicts[verdict] = (verdicts[verdict] || 0) + 1;
    }

    return {
      ...base,
      outcome: results.length ? "found" : "none",
      count: results.length,
      verdicts,
      budgetFallback: Boolean(parseJson(outputs.search_meta)?.budgetFallback),
    };
  }

  if (typeof outputs.message === "string")
    return { ...base, outcome: "none", count: 0, message: outputs.message };

  return { ...base, outcome: run.status === "partial-succeeded" ? "error" : "none", count: 0 };
};

module.exports = { summarizeRun, parseLooseJson };
