/*
 * Рынки назначения (07.10.2026, решение Mikita): одна и та же машина с
 * аукциона по-разному выгодна в Беларуси, Польше и России. Рынок задаёт
 * ставки ввоза, источники цены перепродажи и логистику. Лот на аукционе от
 * рынка не зависит, поэтому поиск один, а оценок — столько, сколько рынков.
 */
const MARKETS = {
  BY: { id: "BY", label: "Беларусь", rates: () => require("./rates") },
  PL: { id: "PL", label: "Польша", rates: () => require("./rates-pl") },
};

const DEFAULT_MARKET = "BY";

const marketOf = (id) => {
  const key = String(id || DEFAULT_MARKET).toUpperCase();

  return MARKETS[key] || null;
};

module.exports = { DEFAULT_MARKET, MARKETS, marketOf };
