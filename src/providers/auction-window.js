/*
 * Лот с прошедшими торгами уходит из поиска на следующий день после
 * торгов (решение Mikita 14.09.2026): в день торгов его ещё видно,
 * дальше он живёт только в истории. День считаем по Минску.
 *
 * Перенесённые торги приходят с новой датой при следующем обновлении
 * каталога, и лот возвращается в поиск сам. Лот без даты не прячем,
 * а помечаем: отсутствие даты — не доказательство, что торги прошли.
 */

const minskDay = date => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Minsk",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(date);

const auctionWindow = (car, now = new Date()) => {
  const saleTime = car && car.saleDate ? new Date(car.saleDate) : null;

  if (!saleTime || Number.isNaN(saleTime.getTime()))
    return { over: false, saleDateConfirmed: false };

  return {
    over: minskDay(saleTime) < minskDay(now),
    saleDateConfirmed: true,
  };
};

module.exports = { auctionWindow };
