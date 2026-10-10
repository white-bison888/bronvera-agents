/*
 * Тип продажи лота на bid.cars (решение Mikita 07.10.2026).
 *
 * Fast Buy — не отдельный аукцион: это обычный лот с торгами, у которого
 * до начала торгов есть цена мгновенного выкупа. Пока окно открыто, лот
 * можно выкупить по ней; выкупили — страница лота показывает «Sold by
 * Fast Buy», торги по нему не состоятся, а цена выкупа и есть итог.
 *
 *   auction       — обычные торги, цены выкупа нет;
 *   fastBuy       — торги идут, и открыт выкуп по фиксированной цене;
 *   fastBuySold   — лот уже выкуплен по Fast Buy.
 *
 * Лот, который ушёл в аукцион, остаётся «fastBuy» в данных выдачи, пока
 * окно открыто, а итог берётся из «Final bid» — это решает наблюдатель
 * ставок, а не этот модуль.
 */
const SALE_TYPES = ["auction", "fastBuy", "fastBuySold"];

const positive = (value) => {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : null;
};

/*
 * Окно Fast Buy из выдачи: buy_now_close_time приходит в секундах до
 * закрытия окна, от момента выдачи. Возвращаем момент закрытия в ISO.
 */
const buyNowCloseAt = (secondsLeft, fetchedAt = new Date()) => {
  const seconds = Number(secondsLeft);

  if (!Number.isFinite(seconds) || seconds <= 0)
    return null;

  return new Date(fetchedAt.getTime() + seconds * 1000).toISOString();
};

const saleTypeOf = ({ buyNowUsd = null, soldByFastBuy = false } = {}) => {
  if (soldByFastBuy)
    return "fastBuySold";

  return positive(buyNowUsd) ? "fastBuy" : "auction";
};

/*
 * Страница лота: «Fast Buy Price: $5,975 USD» и либо кнопка «Buy Now»,
 * либо серая «Sold by Fast Buy». Валюту требуем USD: рядом лежат евро.
 */
const readLotPage = (pageText) => {
  const text = String(pageText || "");
  const priceMatch = text.match(/Fast Buy Price[\s\S]{0,20}?\$\s?([\d,]+)\s*USD/i);
  const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null;

  return {
    buyNowUsd: positive(price),
    soldByFastBuy: /Sold by Fast Buy/i.test(text),
  };
};

const isFastBuy = type => type === "fastBuy" || type === "fastBuySold";

module.exports = { SALE_TYPES, buyNowCloseAt, isFastBuy, readLotPage, saleTypeOf };
