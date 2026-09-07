/*
 * Bid.Cars отдаёт одной строкой сразу четыре вещи:
 *
 *   "Odpala i rusza $6,800 - $7,275 wt. 8 wrz, 15:30 GMT+2 3 d 0 h 58 min do zamknięcia"
 *    состояние      оценка аукциона   дата торгов          сколько осталось
 *
 * Раньше из неё брали только состояние, а дата торгов оставалась пустой
 * у всех лотов — хотя без неё нельзя ни следить за ценой перед закрытием,
 * ни показать, когда машина уходит с молотка.
 */

const MONTHS = {
  sty: 0, lut: 1, mar: 2, kwi: 3, maj: 4, cze: 5,
  lip: 6, sie: 7, wrz: 8, paź: 9, paz: 9, lis: 10, gru: 11,
};

const parseEstimate = (text) => {
  const match = text.match(
    /\$\s?([\d,]+)\s*[-–]\s*\$\s?([\d,]+)/
  );

  if (!match)
    return { estimateMin: null, estimateMax: null };

  const toNumber = value => Number(value.replace(/,/g, "")) || null;

  return {
    estimateMin: toNumber(match[1]),
    estimateMax: toNumber(match[2]),
  };
};

/*
 * Год в строке не указан — только день и месяц. Берём ближайший
 * подходящий: если дата уже прошла больше месяца назад, значит
 * речь о следующем годе.
 */
const parseSaleDate = (text, now = new Date()) => {
  const match = text.match(
    /(\d{1,2})\s+([a-ząćęłńóśźż]{3,4})\.?,?\s+(\d{1,2}):(\d{2})/i
  );

  if (!match)
    return null;

  const day = Number(match[1]);
  const month = MONTHS[match[2].toLowerCase()];

  if (month === undefined)
    return null;

  const hours = Number(match[3]);
  const minutes = Number(match[4]);

  // Время указано в GMT+2 — часовой пояс площадки в Европе.
  let date = new Date(Date.UTC(
    now.getUTCFullYear(), month, day, hours - 2, minutes
  ));

  const monthAgo = now.getTime() - 31 * 24 * 3600 * 1000;

  if (date.getTime() < monthAgo) {
    date = new Date(Date.UTC(
      now.getUTCFullYear() + 1, month, day, hours - 2, minutes
    ));
  }

  return date.toISOString();
};

const parseTimeLeft = (text) => {
  const match = text.match(
    /(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*min)?\s*do\s+zamkni/i
  );

  if (!match)
    return null;

  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);

  const total = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;

  return total > 0 ? total : null;
};

const parseAuctionTiming = (raw, now = new Date()) => {
  const text = String(raw || "");

  if (!text)
    return {};

  const { estimateMin, estimateMax } = parseEstimate(text);

  /*
   * Явная дата надёжнее обратного отсчёта: «осталось 3 дня» верно только
   * на момент сбора страницы, а запись живёт в кэше сутками. Отсчёт
   * используем лишь когда даты в строке нет.
   */
  const saleDate =
    parseSaleDate(text, now) ||
    (parseTimeLeft(text)
      ? new Date(now.getTime() + parseTimeLeft(text)).toISOString()
      : null);

  return {
    saleDate,
    timeLeftMs: saleDate
      ? Math.max(0, new Date(saleDate).getTime() - now.getTime())
      : null,
    auctionEstimateMin: estimateMin,
    auctionEstimateMax: estimateMax,
  };
};

module.exports = { parseAuctionTiming };
