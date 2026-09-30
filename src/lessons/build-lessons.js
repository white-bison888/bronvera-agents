// Пятый принцип методологии: циклическое уточнение.
//
// Считает уроки из истории прогнозов против фактических цен продажи и пишет
// их в agents/lessons/*.md. Уроки короткие — они попадают во вход агентов,
// поэтому каждая строка стоит токенов на каждом прогоне.
//
// Важно: никаких выводов из пустоты. Если пар «прогноз против факта» меньше
// MIN_SAMPLE, урок не выдаётся вовсе — лучше молчать, чем учить шуму.

const fs = require("fs");
const path = require("path");

const MIN_SAMPLE = 10;
const HISTORY = path.join(__dirname, "../../data/recommendations-history.json");
const LESSONS_DIR = path.join(__dirname, "../../agents/lessons");

function readHistory() {
  const raw = JSON.parse(fs.readFileSync(HISTORY, "utf8"));
  return Array.isArray(raw) ? raw : (raw.entries || Object.values(raw)[0] || []);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const percent = (ratio) => `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(0)}%`;

// Пары, где есть и наш потолок, и фактическая цена продажи.
function pairs(history) {
  return history
    .filter((r) => r.actual && Number(r.actual.soldPriceUsd) > 0 && Number(r.maxBidUsd) > 0)
    .map((r) => {
      const sold = Number(r.actual.soldPriceUsd);
      const cap = Number(r.maxBidUsd);
      return {
        sold,
        cap,
        gap: (sold - cap) / cap, // >0 значит рынок ушёл выше нашего потолка
        winnable: sold <= cap,
        repairSource: r.repairCostSource || null,
        decision: r.decision || null,
        marketValueUsd: Number(r.marketValueUsd) || null,
      };
    });
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

function assessorLesson(rows) {
  const bySource = groupBy(rows, "repairSource");
  const lines = [];
  for (const [source, group] of [...bySource].sort((a, b) => b[1].length - a[1].length)) {
    if (group.length < MIN_SAMPLE) continue;
    const gap = median(group.map((r) => r.gap));
    lines.push(
      `- Ремонт по источнику **${source}**: лот уходил в среднем на ` +
        `${percent(gap)} дороже нашей предельной цены (${group.length} лотов).`
    );
  }
  if (!lines.length) return null;

  const norm = bySource.get("norm") || [];
  const photo = bySource.get("photo") || [];
  const extra = [];
  if (norm.length >= MIN_SAMPLE && photo.length >= MIN_SAMPLE) {
    const normGap = median(norm.map((r) => r.gap));
    const photoGap = median(photo.map((r) => r.gap));
    if (normGap > photoGap * 2) {
      const times = Math.round(normGap / photoGap);
      const word = times >= 5 ? "раз" : "раза";
      extra.push(
        `- **Типовой норматив ненадёжен.** Когда стоимость ремонта берётся из норматива, ` +
          `а не с фотографий, промах больше в ${times} ${word}. ` +
          `Без фотографий диапазон ремонта лучше не выдавать вовсе.`
      );
    }
  }
  return [...lines, ...extra].join("\n");
}

function selectorLesson(rows) {
  if (rows.length < MIN_SAMPLE) return null;
  const winnable = rows.filter((r) => r.winnable).length;
  const lines = [
    `- Из ${rows.length} лотов с известным финалом по нашей предельной цене прошли бы ` +
      `${winnable} — это ${Math.round((winnable / rows.length) * 100)}%. ` +
      `Остальные рынок увёл выше. Отбор должен быть щедрым: большая часть кандидатов отвалится на торгах.`,
  ];
  const byDecision = groupBy(rows, "decision");
  const buy = byDecision.get("BUY") || [];
  if (buy.length >= MIN_SAMPLE) {
    lines.push(
      `- Лоты с вердиктом BUY считаются точнее остальных: промах ` +
        `${percent(median(buy.map((r) => r.gap)))} против ` +
        `${percent(median(rows.map((r) => r.gap)))} по всей выборке (${buy.length} лотов).`
    );
  }
  return lines.join("\n");
}

function marketAnalystLesson(rows) {
  const withMarket = rows.filter((r) => r.marketValueUsd > 0);
  if (withMarket.length < MIN_SAMPLE) return null;
  const ratio = median(withMarket.map((r) => r.sold / r.marketValueUsd));
  return (
    `- Фактическая цена на американских торгах составляла ` +
    `${Math.round(ratio * 100)}% от цены целого аналога в Беларуси (медиана по ${withMarket.length} лотам). ` +
    `Это ориентир для проверки: сильное отклонение от него — повод усомниться в цене рынка, а не в лоте.`
  );
}

function render(agent, body, meta) {
  return (
    `<!-- Считается автоматически: node src/lessons/build-lessons.js. Руками не править. -->\n\n` +
    `# Уроки: ${agent}\n\n` +
    `Снято ${meta.date} по ${meta.pairs} парам «прогноз против факта» ` +
    `из ${meta.total} записей истории.\n\n` +
    `${body}\n`
  );
}

function main() {
  const history = readHistory();
  const rows = pairs(history);
  const meta = {
    date: new Date().toISOString().slice(0, 10),
    pairs: rows.length,
    total: history.length,
  };

  if (rows.length < MIN_SAMPLE) {
    console.log(`Пар всего ${rows.length}, нужно ${MIN_SAMPLE}. Уроки не пишу.`);
    return;
  }

  const lessons = {
    "assessor.md": ["ASSESSOR", assessorLesson(rows)],
    "selector.md": ["SELECTOR", selectorLesson(rows)],
    "market-analyst.md": ["MARKET ANALYST", marketAnalystLesson(rows)],
  };

  fs.mkdirSync(LESSONS_DIR, { recursive: true });
  for (const [file, [agent, body]] of Object.entries(lessons)) {
    const target = path.join(LESSONS_DIR, file);
    if (!body) {
      fs.writeFileSync(target, render(agent, "_Данных пока недостаточно._", meta), "utf8");
      console.log(`${file}: данных мало`);
      continue;
    }
    fs.writeFileSync(target, render(agent, body, meta), "utf8");
    console.log(`${file}: ${body.split("\n").length} урок(ов)`);
  }
  console.log(`Готово: ${meta.pairs} пар из ${meta.total} записей.`);
}

if (require.main === module) main();

module.exports = { pairs, assessorLesson, selectorLesson, marketAnalystLesson, median };
