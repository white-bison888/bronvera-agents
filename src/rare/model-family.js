/*
 * Семейство модели и комплектация (02.10.2026, просьба Mikita: аналитику
 * нужно вести «по равным позициям»). guessModel возвращает всё, что в
 * названии после марки до слова про кузов — «911 Turbo», «Grand Cherokee
 * Trackhawk», «Bronco XLT Lariat 5.0L»: комплектация слита с моделью, и
 * «модель» в фильтре дробится на сотни вариантов. Делим на два уровня:
 *
 *   family — линейка («911», «Grand Cherokee», «Model T»);
 *   trim   — остаток («Turbo», «Trackhawk», «XLT Lariat»).
 *
 * Словаря моделей нет, поэтому линейку определяем по самим данным: внутри
 * марки берём самое длинное начало названия (до трёх слов), которое
 * охватывает не меньше 60% лотов предыдущего, более короткого начала.
 * «Grand» почти всегда идёт с «Cherokee» — значит линейка «Grand Cherokee»;
 * «911» дальше расходится на Carrera/Turbo/GT3 по долям меньше 60% —
 * остаётся «911». Слова, которые сами по себе не модель («Model», «Series»,
 * «Type», «Mark»), всегда присоединяют следующее слово.
 */
const MAX_WORDS = 3;
const MIN_EXTEND_SHARE = 0.6;
const MIN_LOTS_TO_EXTEND = 5;
const ALWAYS_EXTEND = new Set(["model", "series", "type", "mark", "mk", "gran", "grand", "range", "land", "santa", "town", "silver", "super", "great", "continental", "el", "la"]);

const tokensOf = model => String(model || "").trim().split(/\s+/).filter(Boolean);

const buildFamilyResolver = (lots) => {
  const prefixCounts = new Map(); // «make|prefix» → число лотов
  for (const lot of lots) {
    if (!lot.model)
      continue;
    const words = tokensOf(lot.model).slice(0, MAX_WORDS);
    for (let length = 1; length <= words.length; length += 1) {
      const key = `${lot.make}|${words.slice(0, length).join(" ")}`;
      prefixCounts.set(key, (prefixCounts.get(key) || 0) + 1);
    }
  }

  const cache = new Map();

  const familyLength = (make, words) => {
    let length = 1;
    while (length < Math.min(words.length, MAX_WORDS)) {
      const current = prefixCounts.get(`${make}|${words.slice(0, length).join(" ")}`) || 0;
      const next = prefixCounts.get(`${make}|${words.slice(0, length + 1).join(" ")}`) || 0;
      const forced = ALWAYS_EXTEND.has(words[length - 1].toLowerCase());
      if (forced || (current >= MIN_LOTS_TO_EXTEND && next / current >= MIN_EXTEND_SHARE))
        length += 1;
      else
        break;
    }
    return length;
  };

  return (lot) => {
    if (!lot.model)
      return { family: null, trim: null, generation: null };
    const key = `${lot.make}|${lot.model}`;
    const known = cache.get(key);
    if (known)
      return known;

    const words = tokensOf(lot.model);
    const length = familyLength(lot.make, words);
    const rest = words.slice(length).join(" ");
    // «(997) Turbo -» → поколение «997», комплектация «Turbo»: шифр поколения в скобках — отдельный признак.
    const generation = (rest.match(/\(([^)]{2,12})\)/) || [])[1] || null;
    const trim = rest.replace(/\([^)]*\)/g, " ").replace(/^[\s\-–,]+|[\s\-–,]+$/g, "").replace(/\s+/g, " ") || null;
    const result = { family: words.slice(0, length).join(" "), trim, generation };
    cache.set(key, result);
    return result;
  };
};

module.exports = { buildFamilyResolver };
