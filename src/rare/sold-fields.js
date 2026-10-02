/*
 * Единые для всех площадок поля проданных лотов (02.10.2026, просьба
 * Mikita: для Stats нужны пробег, цвет и коробка передач): площадки
 * называют их по-разному, а фильтры на сайте требуют одинаковых значений.
 *
 *  - mileage — пробег в милях (километры пересчитываем);
 *  - transmissionKind — "manual" | "automatic" | null: механика или
 *    автомат (робот, вариатор и «преселектор» — тоже автомат);
 *  - exteriorColor — цвет кузова как написала площадка («Guards Red»);
 *  - colorGroup — один из базовых цветов для фильтра (colorGroupOf).
 */

const KM_PER_MILE = 1.609344;

const toMiles = (value, unit) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  return /^k/i.test(String(unit || "")) ? Math.round(value / KM_PER_MILE) : Math.round(value);
};

/* «64,500 Miles», «25,660 Km », «12k miles», «7,800 mi» → мили. */
const parseMileageText = (text) => {
  const match = String(text || "").match(/([\d,]+(?:\.\d+)?)\s*(k)?\s*[-\s]*(miles?|mi\b|km|kilometers?|kilometres?)/i);
  if (!match)
    return null;
  const base = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(base))
    return null;
  const value = match[2] ? base * 1000 : base;
  return toMiles(value, /^k/i.test(match[3]) ? "km" : "miles");
};

const transmissionKind = (raw) => {
  const text = String(raw || "");
  if (!text)
    return null;
  if (/automatic|dual-clutch|\bdct\b|\bpdk\b|\bdsg\b|\bcvt\b|tiptronic|steptronic|semi-auto|preselector|автомат|робот/i.test(text))
    return "automatic";
  if (/manual|stick|механик/i.test(text))
    return "manual";
  return null;
};

/*
 * Цвет — слова из названия краски → базовая группа. Порядок важен:
 * «silver grey» — серебристый, «black cherry» — по первому совпадению.
 * Всё, что не распознали, — «Другой» (не выдумываем).
 */
const COLOR_RULES = [
  ["Серебристый", /\b(?:silver|argent|argento)/i],
  ["Серый", /\b(?:gr[ae]y|graphite|anthracite|gunmetal|charcoal|slate|titanium|steel|gris|grigio|ash\b)/i],
  ["Чёрный", /\b(?:black|ebony|onyx|jet\b|noir|nero|obsidian|raven|schwarz)/i],
  ["Белый", /\b(?:white|ivory|pearl|alpine|blanc|bianco|polar|snow|weiss|chalk)/i],
  ["Красный", /\b(?:red\b|rosso|burgundy|maroon|crimson|cherry|ruby|carmine|claret|scarlet|garnet|bordeaux|rouge|rosa\b|corsa)/i],
  ["Синий", /\b(?:blue|azure|azzurro|celeste|aqua|navy|cobalt|indigo|sapphire|bleu|blu\b|cyan|denim|lapis)/i],
  ["Зелёный", /\b(?:green|olive|sage|moss|emerald|forest|verde|teal|british racing|brg\b|vert\b)/i],
  ["Жёлтый", /\b(?:yellow|giallo|canary|saffron|sunflower|mustard|lemon|jaune)/i],
  ["Золотой", /\b(?:gold)/i],
  ["Оранжевый", /\b(?:orange|arancio|tangerine|copper|burnt|papaya|rust)/i],
  ["Коричневый", /\b(?:brown|bronze|chocolate|mocha|chestnut|cocoa|brandy|coffee|walnut|espresso|marrone|havana|cognac|umber)/i],
  ["Бежевый", /\b(?:beige|tan\b|champagne|sand\b|taupe|khaki|cream|buff\b|biscuit|parchment|sable|oatmeal)/i],
  ["Фиолетовый", /\b(?:purple|violet|plum|lavender|amethyst|aubergine|magenta|lilac|viola)/i],
];

/* «harmonious Dove Blue», «red exterior and», «livery of blue» → «Dove Blue», «red», «blue»: убираем эпитеты и служебные слова. */
const FLUFF_START = /^(?:(?:livery|shade|hue|color|colour|paint|finish)\s+of\s+|(?:harmonious|attractive|elegant|beautiful|handsome|striking|stunning|gorgeous|lovely|rich|classic|period|original|factory|delightful|subtle|sophisticated|handsomely|tasteful|appealing|eye-catching|vibrant)(?:\s+|$))+/i;
const FLUFF_END = /\s+(?:exterior|bodywork|body|paint|paintwork|livery|finish|hue|shade|colou?r|coachwork|and|with|over)$/i;

const cleanColor = (raw) => {
  let text = String(raw || "").trim();
  let previous = null;
  while (text !== previous) {
    previous = text;
    text = text.replace(FLUFF_START, "").replace(FLUFF_END, "").trim();
  }
  return text || null;
};

const colorGroupOf = (raw) => {
  const text = String(raw || "").trim();
  if (!text)
    return null;
  for (const [group, pattern] of COLOR_RULES) {
    if (pattern.test(text))
      return group;
  }
  return "Другой";
};

const HTML_ENTITIES = { amp: "&", quot: "\"", "#039": "'", "#8217": "'", "#8220": "\"", "#8221": "\"", apos: "'", nbsp: " " };
const decodeEntities = text => String(text || "").replace(/&(#\d+|[a-z]+);/gi, (full, code) => HTML_ENTITIES[code.toLowerCase()] ?? full);

/*
 * Описание лота BaT («excerpt») пишется по одному шаблону: «…is finished in
 * Guards Red over black leather and powered by … linked with a
 * five-speed manual transmission…», пробег — «has 45k miles» или «4,200-Mile»
 * в заголовке. Разбираем только то, что названо прямо; чего нет — null.
 */
const parseBatExcerpt = (title, excerpt) => {
  const text = decodeEntities(excerpt).replace(/\s+/g, " ");

  let exteriorColor = null;
  const finishedIn = text.match(/\b(?:finished|painted|refinished|repainted|resprayed|wrapped|repaint|respray|paint)\s+(?:in|with)\s+(.+?)(?=\s+(?:over|with|and|on|at|by|from|after|before|during|when|that|which|featuring)\b|[,.;]|$)/i);
  const dashed = text.match(/\b(?:a|an|the)\s+([A-Za-z]+(?:\s[A-Za-z]+)?)-over-[A-Za-z]+\b/);
  if (finishedIn)
    exteriorColor = finishedIn[1];
  else if (dashed)
    exteriorColor = dashed[1];
  if (exteriorColor) {
    exteriorColor = cleanColor(exteriorColor.trim().replace(/^(?:a|an|the)\s+/i, ""));
    if (!exteriorColor || exteriorColor.split(/\s+/).length > 4 || exteriorColor.length > 40)
      exteriorColor = null;
  }

  const titleMiles = String(title || "").match(/^([\d,]+)(k)?-Mile\b/i);
  let mileage = null;
  if (titleMiles) {
    const base = Number(titleMiles[1].replace(/,/g, ""));
    mileage = Math.round(titleMiles[2] ? base * 1000 : base);
  }
  if (mileage === null) {
    const miles = text.match(/([\d,]+(?:\.\d+)?)\s*(k)?[-\s]*(?:indicated\s+|actual\s+|original\s+|recorded\s+)?miles?\b/i);
    if (miles) {
      const base = Number(miles[1].replace(/,/g, ""));
      const value = miles[2] ? base * 1000 : base;
      if (Number.isFinite(value) && value > 0 && value < 2_000_000)
        mileage = Math.round(value);
    }
  }

  const trans = text.match(/\b((?:[a-z]+-speed\s+)?(?:dual-clutch\s+|sequential\s+|semi-automatic\s+|manual\s+)?(?:manual|automatic|dual-clutch)(?:\s+(?:transmission|transaxle|gearbox))?)/i)
    || text.match(/\b(PDK|DSG|CVT|Tiptronic|Steptronic)\b/i);
  const transmissionRaw = trans ? trans[1] : null;

  return { exteriorColor, mileage, transmissionRaw };
};

/*
 * Описание лота RM Sotheby's — свободный английский текст («finished in Rosso
 * Corsa over a Nero interior», «showing 12,345 kilometres on the odometer»,
 * «a five-speed manual gearbox»). Цвет, пробег (мили или километры) и коробку
 * берём только если они названы прямо.
 */
const parseRmText = (text) => {
  const clean = decodeEntities(text).replace(/\s+/g, " ");

  let exteriorColor = null;
  const finished = clean.match(/\b(?:finished|painted|refinished|repainted|resprayed|presented|delivered|supplied|ordered)\s+(?:new\s+)?in\s+(?:its\s+|a\s+|an\s+|the\s+)?(?:original\s+|factory\s+)?(.+?)(?=\s+(?:over|with|and|on|at|by|from|after|before|during|when|that|which|featuring|paint|livery)\b|[,.;:()]|$)/i);
  if (finished) {
    exteriorColor = cleanColor(finished[1]);
    if (!exteriorColor || exteriorColor.split(/\s+/).length > 4 || exteriorColor.length > 40 || /^(?:a|an|the|its|his|her|their|period|ivory|black leather)$/i.test(exteriorColor))
      exteriorColor = null;
  }

  // Автор очерка часто пишет без «finished»: «resplendent in Rosso Corsa», «in its original Azzurro». Берём слово краски
  // только если оно распознано как цвет и сразу за ним не идёт про салон/обивку.
  if (!exteriorColor) {
    for (const match of clean.matchAll(/\b(?:in|wearing|sporting|resplendent in|dressed in|clad in)\s+(?:its\s+|a\s+|an\s+|the\s+)?(?:original\s+|factory\s+|period\s+|striking\s+|classic\s+)?((?:[A-Za-z'-]+\s){0,2}[A-Za-z'-]+)(\s+(?:leather|upholstery|interior|cloth|trim|vinyl|top|hood|roof|livery)\b)?/gi)) {
      if (match[2])
        continue;
      const phrase = cleanColor(match[1].split(/\s+(?:with|and|over|on|at|by|from|that|which|a|an|the|to|for|of)\b/i)[0]) || "";
      const group = colorGroupOf(phrase);
      if (group && group !== "Другой" && phrase.split(/\s+/).length <= 3) {
        exteriorColor = phrase;
        break;
      }
    }
  }

  let mileage = null;
  const withContext = clean.match(/(?:odometer|indicated|mileage|recorded|showing|shows|reads|reading|covered|driven|from new)[^.]{0,80}?([\d][\d,. ]*\d|\d)\s*(k)?\s*(miles?|mi\b|km|kilomet(?:er|re)s?)/i)
    || clean.match(/([\d][\d,. ]*\d|\d)\s*(k)?\s*(miles?|mi\b|km|kilomet(?:er|re)s?)\s+(?:from new|on the odometer|indicated|recorded|covered)/i);
  if (withContext) {
    const base = Number(withContext[1].replace(/[,. ]/g, ""));
    const value = withContext[2] ? base * 1000 : base;
    if (Number.isFinite(value) && value > 0 && value < 2_000_000)
      mileage = toMiles(value, /^k/i.test(withContext[3]) ? "km" : "miles");
  }

  const trans = clean.match(/\b((?:[a-z]+-speed\s+)?(?:semi-automatic\s+|dual-clutch\s+|sequential\s+|manual\s+)?(?:manual|automatic|semi-automatic|dual-clutch)(?:\s+(?:transmission|transaxle|gearbox))?)/i)
    || clean.match(/\b(PDK|DSG|CVT|Tiptronic|Steptronic)\b/i);

  return { exteriorColor, mileage, transmissionRaw: trans ? trans[1] : null };
};

module.exports = { cleanColor, parseRmText, colorGroupOf, decodeEntities, parseBatExcerpt, parseMileageText, toMiles, transmissionKind };
