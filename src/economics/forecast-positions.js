const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const defaultRates = require("./rates");

/*
 * ПОПРАВКИ ТОЧКИ ПРОГНОЗА ПО МОДЕЛЯМ
 *
 * Прогноз BRONVERA — точка внутри диапазона Bid.Cars (по умолчанию 77%).
 * На сайте в «Поправках» видно, у какой модели цена торгов раз за разом
 * уходит в одну сторону, и Mikita решает: применить, подождать, отклонить
 * или отменить применённое (решение 2026-09-15). Здесь хранятся действующие
 * точки и вся история решений; расчёт спрашивает точку для модели лота.
 */

const CHOICES = ["apply", "wait", "reject", "undo"];

const fileName = () => process.env.FORECAST_POSITIONS_FILE
  || path.join(process.cwd(), "data", "forecast-positions.json");

// «MODEL Y» и «Model Y» — одна модель; ключ без регистра и знаков.
const modelKey = model => String(model || "").toLowerCase().replace(/[^a-z0-9а-яё]/g, "");

const read = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileName(), "utf8"));
    return { positions: parsed.positions || {}, decisions: parsed.decisions || [] };
  } catch {
    return { positions: {}, decisions: [] };
  }
};

const write = (state) => {
  const file = fileName();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(`${file}.tmp`, file);
};

// Действующая точка для модели лота или null — тогда берётся общая из rates.js.
const positionFor = (model) => {
  const key = modelKey(model);
  const current = key ? read().positions[key] : null;

  return current && Number.isFinite(current.position) ? current.position : null;
};

const decide = ({ model, choice, position, basis = null, now = new Date() }) => {
  const key = modelKey(model);

  if (!key)
    throw new Error("Не указана модель");

  if (!CHOICES.includes(choice))
    throw new Error(`Решение должно быть одним из: ${CHOICES.join(", ")}`);

  const state = read();
  const active = state.positions[key] || null;

  if (choice === "apply" && !(Number.isFinite(position) && position >= 0 && position <= 1.5))
    throw new Error("Точка прогноза должна быть числом от 0 до 1,5");

  if (choice === "undo" && !active)
    throw new Error(`Для ${model} нет применённой поправки`);

  const decision = {
    id: crypto.randomUUID(),
    at: now.toISOString(),
    model,
    key,
    choice,
    // Точка до решения и после: при отмене возвращается общая.
    from: active ? active.position : defaultRates.forecastPosition,
    to: choice === "apply" ? position : choice === "undo" ? defaultRates.forecastPosition : (active ? active.position : defaultRates.forecastPosition),
    basis,
  };

  if (choice === "apply")
    state.positions[key] = { model, position, since: decision.at, decisionId: decision.id };

  if (choice === "undo")
    delete state.positions[key];

  state.decisions.unshift(decision);
  write(state);

  return decision;
};

// Дописать к решению то, что стало известно после него: например, какие лоты пересчитаны.
const annotate = (id, fields) => {
  const state = read();
  const decision = state.decisions.find(item => item.id === id);

  if (!decision)
    return null;

  Object.assign(decision, fields);
  write(state);
  return decision;
};

const list = () => ({ defaultPosition: defaultRates.forecastPosition, ...read() });

module.exports = { positionFor, decide, annotate, list, modelKey, CHOICES };
