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
  ["Серебристый", /silver|argent|argento/i],
  ["Серый", /gr[ae]y|graphite|anthracite|gunmetal|charcoal|slate|titanium|steel|gris|grigio|ash\b/i],
  ["Чёрный", /black|ebony|onyx|\bjet\b|noir|nero|obsidian|raven|schwarz/i],
  ["Белый", /white|ivory|pearl|alpine|blanc|bianco|polar|snow|weiss/i],
  ["Красный", /\bred\b|rosso|burgundy|maroon|crimson|cherry|ruby|carmine|claret|scarlet|garnet|bordeaux|rouge|\brosa?\b|corsa/i],
  ["Синий", /blue|azure|aqua|navy|cobalt|indigo|sapphire|bleu|blu\b|cyan|denim|lapis/i],
  ["Зелёный", /green|olive|sage|moss|emerald|forest|verde|teal|british racing|\bbrg\b|vert/i],
  ["Жёлтый", /yellow|giallo|canary|saffron|sunflower|mustard|lemon|\bjaune/i],
  ["Золотой", /gold|champagne gold/i],
  ["Оранжевый", /orange|arancio|tangerine|copper|burnt|papaya|\brust/i],
  ["Коричневый", /brown|bronze|chocolate|mocha|chestnut|cocoa|brandy|coffee|walnut|espresso|marrone|havana|cognac|umber/i],
  ["Бежевый", /beige|\btan\b|champagne|sand|taupe|khaki|cream|buff|biscuit|parchment|sable|oatmeal/i],
  ["Фиолетовый", /purple|violet|plum|lavender|amethyst|aubergine|magenta|lilac|\bviola/i],
];

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
    exteriorColor = exteriorColor.trim().replace(/^(?:a|an|the)\s+/i, "");
    if (exteriorColor.split(/\s+/).length > 4 || exteriorColor.length > 40)
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

module.exports = { colorGroupOf, decodeEntities, parseBatExcerpt, parseMileageText, toMiles, transmissionKind };
