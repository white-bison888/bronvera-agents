/*
 * Спрос на лот (решение Mikita 07.10.2026): сколько людей смотрело лот на
 * bid.cars. Число есть только на странице лота — «79 people viewed this
 * vehicle» — и это накопительный счётчик, а не «сейчас смотрят». Один замер
 * почти ничего не говорит, поэтому храним историю замеров и смотрим на
 * скорость роста.
 *
 * Пороги уровней предварительные: данных, на которых их можно проверить,
 * пока нет. Когда накопятся лоты с итогом торгов, сверяем уровень с тем,
 * уходили ли лоты дороже прогноза, и правим пороги здесь.
 */
const MAX_POINTS = 60;

// Окно, за которое считаем скорость роста: короче — шум, длиннее — не видно разгона.
const RATE_WINDOW_MS = 3 * 3600000;

const THRESHOLDS = {
  highViews: 150,
  highPerHour: 8,
  lowViews: 30,
  lowPerHour: 1,
};

const readViews = (pageText) => {
  const match = String(pageText || "").match(/([\d,]+)\s+people\s+viewed this vehicle/i);

  if (!match)
    return null;

  const views = Number(match[1].replace(/,/g, ""));

  return Number.isFinite(views) ? views : null;
};

/*
 * Добавляет замер к истории лота. Счётчик только растёт, поэтому меньшее
 * значение — сбой чтения, такой замер отбрасываем.
 */
const addPoint = (history, views, at = new Date().toISOString()) => {
  const points = Array.isArray(history) ? history : [];
  const last = points[points.length - 1];

  if (!Number.isFinite(views) || (last && views < last.views))
    return points;

  return [...points, { views, at }].slice(-MAX_POINTS);
};

const demandOf = (history) => {
  const points = Array.isArray(history) ? history : [];
  const last = points[points.length - 1];

  if (!last)
    return null;

  const lastTime = new Date(last.at).getTime();

  // Самый ранний замер внутри окна; если замер один — скорость неизвестна.
  const first = points.find(point => lastTime - new Date(point.at).getTime() <= RATE_WINDOW_MS);
  const spanMs = first ? lastTime - new Date(first.at).getTime() : 0;

  // Короче 20 минут скорость не считаем: рост на пару просмотров выглядел бы разгоном.
  const perHour = spanMs >= 20 * 60000 ? ((last.views - first.views) / spanMs) * 3600000 : null;
  const grown = first && first !== last ? last.views - first.views : null;

  let level = "normal";

  if (last.views >= THRESHOLDS.highViews || (perHour !== null && perHour >= THRESHOLDS.highPerHour))
    level = "high";
  else if (last.views < THRESHOLDS.lowViews && (perHour === null || perHour < THRESHOLDS.lowPerHour))
    level = "low";

  return {
    views: last.views,
    checkedAt: last.at,
    perHour: perHour === null ? null : Math.round(perHour * 10) / 10,
    grownInWindow: grown,
    windowHours: RATE_WINDOW_MS / 3600000,
    level,
    // Один замер — уровень только по числу просмотров, без тренда.
    preliminary: perHour === null,
    points: points.slice(-24).map(point => ({ views: point.views, at: point.at })),
  };
};

module.exports = { MAX_POINTS, THRESHOLDS, addPoint, demandOf, readViews };
