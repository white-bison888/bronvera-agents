/*
 * ЛОГИСТИКА ПО ПОРТАМ США (решение Mikita 07.10.2026).
 *
 * Раньше доставка в порт и море были одной суммой на всех: $500 и $995. Реальные
 * цены зависят от штата стоянки (какой порт и сколько везти по США) и от порта
 * отправки: Нью-Йорк, Саванна, Хьюстон и Лос-Анджелес стоят по-разному.
 *
 * Источник — калькулятор westmotors.by (07.10.2026), цены на 10 000 $ для легкового
 * автомобиля; штат берём по площадке, порт — тот, что у площадки в их справочнике.
 * Это опубликованные расценки перевозчика, а не наш счёт: при реальных счетах
 * таблицы заменить. Пересмотр — раз в квартал или при заметном расхождении со счётом.
 *
 * Помечено «оценка»: Хьюстон и Саванна в Бремерхафен не снимались (сервис ответил
 * «слишком много запросов»), взято как у Нью-Йорка и Лос-Анджелеса: ровно на $50
 * дешевле, чем в Клайпеду.
 */
const PORT_AND_INLAND_BY_STATE = {
  AK: ["los-angeles", 3025], AL: ["savannah", 500], AR: ["houston", 565], AZ: ["los-angeles", 475],
  CA: ["los-angeles", 300], CO: ["houston", 750], CT: ["new-york", 345], DC: ["new-york", 400],
  DE: ["new-york", 375], FL: ["savannah", 400], GA: ["savannah", 400], HI: ["los-angeles", 1765],
  IA: ["new-york", 725], ID: ["los-angeles", 800], IL: ["new-york", 265], IN: ["new-york", 765],
  KS: ["new-york", 675], KY: ["savannah", 575], LA: ["houston", 465], MA: ["new-york", 500],
  MD: ["new-york", 425], ME: ["new-york", 500], MI: ["new-york", 750], MN: ["new-york", 1075],
  MO: ["new-york", 725], MS: ["savannah", 550], MT: ["los-angeles", 925], NC: ["savannah", 500],
  ND: ["new-york", 1175], NE: ["new-york", 775], NH: ["new-york", 500], NJ: ["new-york", 275],
  NM: ["houston", 725], NV: ["los-angeles", 445], NY: ["new-york", 445], OH: ["new-york", 650],
  OK: ["houston", 730], OR: ["los-angeles", 765], PA: ["new-york", 525], RI: ["new-york", 465],
  SC: ["savannah", 400], SD: ["los-angeles", 675], TN: ["savannah", 550], TX: ["houston", 475],
  UT: ["los-angeles", 1075], VA: ["savannah", 665], VT: ["new-york", 600], WA: ["los-angeles", 675],
  WI: ["new-york", 375], WV: ["new-york", 700], WY: ["los-angeles", 1325],
};

// Море, $: порт США → порт назначения в ЕС.
const SEA_USD = {
  klaipeda: { "new-york": 1350, savannah: 1325, houston: 1375, "los-angeles": 1850 },
  // Хьюстон и Саванна — оценка (см. выше).
  bremerhaven: { "new-york": 1300, savannah: 1275, houston: 1325, "los-angeles": 1800 },
};

// Какой порт ЕС используем для рынка: Беларусь — Клайпеда, Польша — Бремерхафен (дешевле Клайпеды).
const ROUTE_BY_DESTINATION = { BY: "klaipeda", PL: "bremerhaven" };

// Последний отрезок: Клайпеда → Минск 1 100 EUR; Бремерхафен → Варшава 2 900 PLN.
const LAND = {
  BY: { currency: "EUR", amount: 1100 },
  PL: { currency: "PLN", amount: 2900 },
};

const stateOf = location => (String(location || "").match(/\(([A-Z]{2})\)\s*$/) || [])[1] || null;

/*
 * Логистика лота: сколько до порта по США, море и последний отрезок — в долларах.
 * Штата нет в таблице (Пуэрто-Рико, неизвестное место) — null: расчёт берёт прежние общие ставки.
 */
const logisticsFor = ({ destination = "BY", location, rates }) => {
  const state = stateOf(location);
  const entry = state ? PORT_AND_INLAND_BY_STATE[state] : null;
  const route = ROUTE_BY_DESTINATION[destination];

  if (!entry || !route || !LAND[destination])
    return null;

  const [port, inlandUsd] = entry;
  const land = LAND[destination];
  const toUsd = land.currency === "EUR"
    ? rates.bynPerEur ? rates.bynPerEur / rates.bynPerUsd : null
    : rates.plnPerUsd ? 1 / rates.plnPerUsd : null;

  if (toUsd === null)
    return null;

  return {
    state,
    port,
    route,
    inlandUsd,
    seaUsd: SEA_USD[route][port],
    landUsd: land.amount * toUsd,
    seaEstimated: route === "bremerhaven" && (port === "savannah" || port === "houston"),
  };
};

module.exports = { LAND, PORT_AND_INLAND_BY_STATE, ROUTE_BY_DESTINATION, SEA_USD, logisticsFor, stateOf };
