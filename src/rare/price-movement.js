const { REGIONS, regionOf } = require("./regions");

/*
 * «Что дорожает» (10.10.2026): изменение цены за 12 месяцев по равной позиции — марка, линейка, поколение, — внутри
 * одного региона продажи и одной площадки. Решения Mikita: регионы не смешиваем; заголовок горячий, но каждая цифра
 * подписана числом продаж (принцип 4 методологии — проверка выводов).
 *
 * Почему одна площадка: история разных площадок начинается в разное время и они продают разное (у BaT ранние месяцы
 * неполны), поэтому сравнение «год назад и сейчас» честно только внутри одной. Для позиции берём ту площадку,
 * где продаж в обоих окнах больше всего.
 *
 * Не берём: непроданные, доработанные (рестомод, реплика), лоты без года и без цены. Порог для списков — 20 продаж в каждом окне;
 * от 10 до 19 цифра есть, но с пометкой «мало продаж» и в рейтинг не идёт.
 */

const MONTH_MS = 30.44 * 86400_000;
const MIN_RANKED = 20;
const MIN_SHOWN = 10;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const confidenceOf = (n) => {
  if (n >= 50)
    return "high";
  if (n >= MIN_RANKED)
    return "medium";
  return "low";
};

/* lots — лоты индекса; resolve — справочник (lot → { family, generation, listed }). */
const computeMovement = (lots, resolve, { now = Date.now(), months = 12, minRanked = MIN_RANKED, minShown = MIN_SHOWN } = {}) => {
  const windowMs = months * MONTH_MS;
  const nowFrom = now - windowMs;
  const prevFrom = now - 2 * windowMs;
  const groups = new Map(); // «регион|марка|линейка|поколение|площадка» → { now: [цены], prev: [цены] }

  for (const lot of lots) {
    if (lot.sold === false || typeof lot.salePrice !== "number" || lot.salePrice <= 0 || typeof lot.year !== "number")
      continue;
    if ((lot.flags || []).includes("modified"))
      continue;
    const at = Date.parse(lot.soldAt);
    if (!(at >= prevFrom && at <= now))
      continue;
    const { region } = regionOf(lot);
    const resolved = resolve(lot);
    if (!region || !resolved.family)
      continue;
    const key = [region, lot.make, resolved.family, resolved.generation || "", lot.source].join("|");
    const group = groups.get(key) || { now: [], prev: [] };
    (at >= nowFrom ? group.now : group.prev).push(lot.salePrice);
    groups.set(key, group);
  }

  // Для каждой позиции в регионе — площадка с наибольшим числом продаж в слабейшем окне.
  const best = new Map();
  for (const [key, group] of groups) {
    const [region, make, family, generation, source] = key.split("|");
    const strength = Math.min(group.now.length, group.prev.length);
    if (strength < minShown)
      continue;
    const positionKey = [region, make, family, generation].join("|");
    const current = best.get(positionKey);
    if (!current || strength > current.strength) {
      const medianNow = median(group.now);
      const medianPrev = median(group.prev);
      best.set(positionKey, {
        region, make, family, generation: generation || null, source, strength,
        medianNow, medianPrev, nNow: group.now.length, nPrev: group.prev.length,
        change: Math.round(((medianNow / medianPrev) - 1) * 1000) / 10, // проценты с десятой
        confidence: confidenceOf(strength),
        ranked: strength >= minRanked,
      });
    }
  }
  return [...best.values()];
};

const label = item => [item.make, item.family, item.generation].filter(Boolean).join(" ");

/* Топ растущих и падающих в регионе + сколько позиций вообще можно оценить по каждому региону (для вкладок). */
const rankMovement = (items, { region, limit = 10 } = {}) => {
  const ranked = items.filter(item => item.ranked);
  const inRegion = ranked.filter(item => item.region === region).map(item => ({ ...item, label: label(item) }));
  const rising = inRegion.filter(item => item.change > 0).sort((a, b) => b.change - a.change).slice(0, limit);
  const falling = inRegion.filter(item => item.change < 0).sort((a, b) => a.change - b.change).slice(0, limit);
  const regions = REGIONS.map(({ id, label: name }) => ({ id, label: name, positions: ranked.filter(item => item.region === id).length }));
  const changes = inRegion.map(item => item.change).sort((a, b) => a - b);
  return {
    region,
    positions: inRegion.length,
    medianChange: changes.length ? changes[Math.floor(changes.length / 2)] : null,
    rising,
    falling,
    regions,
  };
};

module.exports = { computeMovement, rankMovement, MIN_RANKED, MIN_SHOWN };
