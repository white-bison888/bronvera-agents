/*
 * Комплектация лота так, как её называет bid.cars (07.10.2026, просьба
 * Mikita): «Standard Range Plus Rear-Wheel Drive», «Long Range Dual Motor».
 * Это подтверждённый площадкой текст, а не догадка по VIN — NHTSA такого не
 * различает. Полный текст есть только в заголовке страницы лота; в выдаче
 * поиска он обрезан многоточием, у Copart часто пуст — такое не берём.
 */
const MAKE_MODEL = /\b(?:19|20)\d{2}\s+Tesla\s+Model\s*[3SXY]\b\s*,\s*([^\n\r]+)/i;

const TRUNCATED = /(\.\.\.|…)\s*$/;

/* «STANDARD RANGE PLUS REAR-WHEEL DRIVE» → «Standard Range Plus Rear-Wheel Drive»; сочетания вроде 100D/P85 не трогаем. */
const tidyTrim = (text) => {
  const clean = String(text || "").replace(/\s+/g, " ").trim();

  if (!clean)
    return null;

  // Слова целиком заглавными (в том числе через дефис и слэш) — в обычный регистр; коды 100D, P85D остаются.
  return clean.replace(/[A-Z][A-Z-]{3,}/g, word => word[0] + word.slice(1).toLowerCase().replace(/-([a-z])/g, (_, c) => `-${c.toUpperCase()}`));
};

// Страница лота: «2021 TESLA MODEL 3, STANDARD RANGE PLUS REAR-WHEEL DRIVE» и следом VIN.
const readTrimFromPage = (pageText) => {
  const match = String(pageText || "").match(MAKE_MODEL);

  if (!match)
    return null;

  const trim = match[1].replace(/\b[A-HJ-NPR-Z0-9]{17}\b.*$/i, "").trim();

  return trim && !TRUNCATED.test(trim) ? tidyTrim(trim) : null;
};

// Поле trim реестра — «2021 Tesla Model 3, Long Range Dual...» целиком, с годом и моделью.
const trimFromListing = (listingTrim) => {
  const text = String(listingTrim || "");
  const comma = text.indexOf(",");

  if (comma < 0 || TRUNCATED.test(text))
    return null;

  const trim = text.slice(comma + 1).trim();

  return trim && trim !== "---" ? tidyTrim(trim) : null;
};

module.exports = { readTrimFromPage, tidyTrim, trimFromListing };
