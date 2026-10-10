/*
 * Регион продажи (10.10.2026, решение Mikita: цены разных рынков не смешиваем, каждый регион выделяем отдельно).
 * Регион — там, где машина находится / проходят торги, а не валюта: BaT продаёт европейские машины в долларах.
 * Источники страны: BaT — country_code списка; Collecting Cars — countryCode поиска; RM — адрес аукциона (JSON-LD Event);
 * Gooding — адрес аукциона на странице лота; Hemmings — США. Если страны нет, берём по валюте цены (запасной вариант, помечаем
 * в regionOf как «по валюте»).
 */
const REGIONS = [
  { id: "US", label: "США" },
  { id: "CA", label: "Канада" },
  { id: "GB", label: "Великобритания" },
  { id: "EU", label: "Европа" },
  { id: "AU", label: "Австралия и Новая Зеландия" },
  { id: "JP", label: "Япония" },
  { id: "OTHER", label: "Другие страны" },
];

// Континентальная Европа одним регионом: ЕС, Швейцария, Норвегия, Исландия, Лихтенштейн, Монако и другие малые.
const EUROPE = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "CH", "NO", "IS", "LI", "MC", "AD", "SM", "VA", "RS", "UA", "TR"]);

const COUNTRY_NAMES = {
  "united states": "US", "usa": "US", "united states of america": "US", "united kingdom": "GB", "uk": "GB", "great britain": "GB", "england": "GB", "scotland": "GB",
  "wales": "GB", "france": "FR", "germany": "DE", "italy": "IT", "spain": "ES", "switzerland": "CH", "monaco": "MC", "netherlands": "NL", "belgium": "BE",
  "canada": "CA", "australia": "AU", "new zealand": "NZ", "japan": "JP", "portugal": "PT", "austria": "AT", "sweden": "SE", "ireland": "IE", "uae": "AE",
};

/* «us», «US», «United States» → «US»; неизвестное — null. */
const normalizeCountry = (value) => {
  const text = String(value ?? "").trim();
  if (!text)
    return null;
  if (/^[a-z]{2}$/i.test(text))
    return text.toUpperCase() === "UK" ? "GB" : text.toUpperCase();
  return COUNTRY_NAMES[text.toLowerCase()] || null;
};

// Запасной вариант, когда страны нет: по валюте. Евро — Европа; доллары — США (для BaT ненадёжно, поэтому там страну берём из списка).
const COUNTRY_BY_CURRENCY = { USD: "US", GBP: "GB", EUR: "DE", CHF: "CH", AUD: "AU", NZD: "NZ", CAD: "CA", JPY: "JP" };

const regionOfCountry = (country) => {
  if (!country)
    return null;
  if (country === "US" || country === "CA" || country === "GB" || country === "JP")
    return country;
  if (country === "AU" || country === "NZ")
    return "AU";
  return EUROPE.has(country) ? "EU" : "OTHER";
};

/* { country, region, basis } для лота: basis — "country" (страна названа) или "currency" (по валюте) или null (неизвестно). */
const regionOf = (lot) => {
  const country = normalizeCountry(lot?.country);
  if (country)
    return { country, region: regionOfCountry(country), basis: "country" };
  const byCurrency = COUNTRY_BY_CURRENCY[String(lot?.currency || "USD").toUpperCase()];
  return byCurrency ? { country: byCurrency, region: regionOfCountry(byCurrency), basis: "currency" } : { country: null, region: null, basis: null };
};

module.exports = { REGIONS, normalizeCountry, regionOfCountry, regionOf };
