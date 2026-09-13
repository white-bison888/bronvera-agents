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

  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

// Длинные названия идут первыми, иначе "september" совпадёт как "sep".
const MONTH_ALTERNATION = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

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
  // Польская форма "8 wrz, 15:30" и английская "14 September, 16:00".
  const match = text.match(
    new RegExp(`(\\d{1,2})\\s+(${MONTH_ALTERNATION})\\.?,?\\s+(\\d{1,2}):(\\d{2})`, "i")
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

const readDuration = (segment) => {
  const days = segment.match(/(\d+)\s*d\b/i);
  const hours = segment.match(/(\d+)\s*h\b/i);
  const minutes = segment.match(/(\d+)\s*min\b/i);

  if (!days && !hours && !minutes)
    return null;

  const total = ((Number(days?.[1] || 0) * 24 + Number(hours?.[1] || 0)) * 60
    + Number(minutes?.[1] || 0)) * 60 * 1000;

  return total > 0 ? total : null;
};

const parseTimeLeft = (text) => {
  // Польская форма: "3 d 0 h 58 min do zamknięcia" — счёт стоит перед фразой.
  const polish = text.match(/(.{0,40}?)do\s+zamkni/i);

  if (polish) {
    const value = readDuration(polish[1]);

    if (value)
      return value;
  }

  // Английская: "Time left 0 d 23 h 26 min 40 sec" — после подписи.
  const english = text.match(/Time\s+left(.{0,40})/i);

  if (english) {
    const value = readDuration(english[1]);

    if (value)
      return value;
  }

  return null;
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
