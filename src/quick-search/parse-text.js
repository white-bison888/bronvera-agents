/*
 * Быстрый разбор строки по правилам — без ИИ: марка и модель из справочника, годы, бюджет, пробег,
 * топливо и несколько псевдонимов. Строка только заполняет форму: что понято, видно сразу, а что нет —
 * остаётся пустым, и пользователь доберёт руками. Угадывать вместо него разбор не должен.
 */
const { CYRILLIC_MAKES } = require("./catalog");

const FUEL_WORDS = [
  [/электро|electric|\bev\b/i, "electric"],
  [/бензин|gasoline|petrol/i, "gasoline"],
  [/дизел|diesel/i, "diesel"],
  [/гибрид|hybrid/i, "hybrid"],
];

const money = (raw, suffix) => {
  const value = Number(String(raw).replace(/[\s,]/g, "").replace(",", "."));

  if (!Number.isFinite(value))
    return null;

  return /k|к|тыс/i.test(suffix || "") ? value * 1000 : value;
};

const parseQuery = (input, catalog = { makes: [], aliases: [] }, now = new Date()) => {
  const original = String(input || "").slice(0, 200);
  // Русские названия марок приводим к латинским, как в справочнике bid.cars.
  const latin = original.toLowerCase().split(/\s+/).map(word => (CYRILLIC_MAKES[word] ? CYRILLIC_MAKES[word].toLowerCase() : word)).join(" ");
  let rest = ` ${latin} `;
  const filters = {};
  const understood = [];

  const take = (pattern) => {
    const match = rest.match(pattern);

    if (match)
      rest = rest.replace(pattern, " ");

    return match;
  };

  // Пробег — раньше бюджета: иначе «до 50 тыс миль» прочитается как бюджет.
  const mileage = take(/пробег(?:ом)?\s*(?:до|<=?)?\s*([\d\s.,]+)\s*(k|к|тыс\.?)?\s*(?:миль|mi)?/);

  if (mileage && money(mileage[1], mileage[2]) > 0) {
    filters.mileageMax = money(mileage[1], mileage[2]);
    understood.push(`пробег до ${Math.round(filters.mileageMax)} миль`);
  }

  // Бюджет: «до 10000», «до $10k», «до 10 тыс». Меньше $500 — не бюджет, строку не трогаем.
  const before = rest;
  const price = take(/(?:до|<=?|up to|under)\s*\$?\s*([\d\s.,]+)\s*(k|к|тыс\.?)?/);

  if (price && money(price[1], price[2]) >= 500) {
    filters.priceMax = money(price[1], price[2]);
    understood.push(`бюджет до $${Math.round(filters.priceMax)}`);
  }
  else {
    rest = before;
  }

  // Годы: «2021–2024», «2021-2024», «с 2021», «2021+», «2023 года».
  const range = take(/\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})\b/);
  const from = !range && take(/(?:с|from|от)?\s*\b((?:19|20)\d{2})\s*(?:\+|и новее|и позже)/);
  const single = !range && !from && take(/\b((?:19|20)\d{2})\b(?:\s*(?:года|год|г\.?|модельн\w*))?/);

  if (range) {
    filters.yearFrom = Math.min(Number(range[1]), Number(range[2]));
    filters.yearTo = Math.max(Number(range[1]), Number(range[2]));
  }
  else if (from) {
    filters.yearFrom = Number(from[1]);
    filters.yearTo = now.getFullYear() + 1;
  }
  else if (single) {
    filters.yearFrom = Number(single[1]);
    filters.yearTo = Number(single[1]);
  }

  if (filters.yearFrom)
    understood.push(filters.yearFrom === filters.yearTo ? `год ${filters.yearFrom}` : `годы ${filters.yearFrom}–${filters.yearTo}`);

  const fuels = FUEL_WORDS.filter(([pattern]) => pattern.test(rest)).map(([, value]) => value);

  if (fuels.length) {
    filters.fuelTypes = fuels;
    understood.push(`топливо: ${fuels.join(", ")}`);
  }

  // Комплектации Tesla и общие названия: 100D, P100D, Performance, Long Range, Standard Range Plus.
  const trims = [];
  const trimPatterns = [
    /\b(p?(?:60|70|75|85|90|100)d)\b/gi,
    /\b(performance)\b/gi,
    /\b(long range)\b/gi,
    /\b(standard range(?: plus)?)\b/gi,
  ];

  for (const pattern of trimPatterns) {
    for (const match of rest.matchAll(pattern)) {
      const name = match[1].replace(/\b([a-z])/g, letter => letter.toUpperCase()).replace(/^P(\d)/, "P$1").replace(/(\d)d$/, "$1D");

      if (!trims.some(item => item.toLowerCase() === name.toLowerCase()))
        trims.push(name);
    }
  }

  if (trims.length) {
    filters.trims = trims;
    understood.push(`комплектация ${trims.join(", ")}`);
  }

  // Псевдонимы: TRX, Raptor, Plaid — сразу марка, модель и комплектация.
  const alias = (catalog.aliases || []).find(item => item.words.some(word => rest.includes(` ${word} `) || rest.includes(` ${word}`)));

  if (alias) {
    filters.make = alias.make;
    filters.models = alias.models;
    if (alias.trims.length)
      filters.trims = [...new Set([...(filters.trims || []), ...alias.trims])];
    understood.push(alias.hint);
  }
  else {
    // Марка из справочника: самое длинное название, встретившееся в строке.
    const make = [...(catalog.makes || [])]
      .sort((a, b) => b.make.length - a.make.length)
      .find(item => rest.includes(` ${item.make.toLowerCase()} `) || rest.includes(` ${item.make.toLowerCase()}`));

    if (make) {
      filters.make = make.make;
      understood.push(`марка ${make.make}`);

      const model = [...make.models]
        .sort((a, b) => b.model.length - a.model.length)
        .find(item => new RegExp(`(^|[^a-zа-я0-9])${item.model.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zа-я0-9]|$)`).test(rest));

      if (model) {
        filters.models = [model.model];
        understood.push(`модель ${model.model}`);
      }
    }
  }

  return { filters, understood, original };
};

module.exports = { parseQuery };
