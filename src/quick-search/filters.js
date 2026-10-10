/*
 * Быстрый поиск без ИИ (прототип, 07.10.2026): параметры приходят готовой формой,
 * поэтому разбирать запрос нейросетью не нужно. Здесь — проверка и приведение
 * параметров формы к тому виду, который понимает поиск по bid.cars.
 *
 * Принцип: плохое значение не молча «чинится», а возвращается ошибкой, которую
 * показывает форма, — иначе пользователь получит поиск не по тому, что выбрал.
 */
const { DAMAGE_MODES, SALE_TYPES, SELLER_MODES } = require("./extra-filters");

const MAX_LIST = 5;

const FUELS = ["electric", "gasoline", "diesel", "hybrid"];
const AUCTIONS = { copart: "Copart", iaai: "IAAI" };

const text = (value, max = 40) => String(value ?? "").trim().slice(0, max);

const list = (value) => {
  const items = Array.isArray(value) ? value : (value ? String(value).split(",") : []);

  return items.map(item => text(item)).filter(Boolean).slice(0, MAX_LIST);
};

// null — не задано, NaN — задано неверно, число — округлённое значение.
const number = (value, min, max) => {
  if (value === null || value === undefined || value === "")
    return null;

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.round(parsed) : NaN;
};

const sanitizeFilters = (input = {}, now = new Date()) => {
  const errors = [];
  const lastYear = now.getFullYear() + 1;
  const filters = {
    make: text(input.make),
    models: list(input.models),
    trims: list(input.trims),
    yearFrom: number(input.yearFrom, 1980, lastYear),
    yearTo: number(input.yearTo, 1980, lastYear),
    mileageMin: number(input.mileageMin, 0, 500000),
    mileageMax: number(input.mileageMax, 0, 500000),
    priceMin: number(input.priceMin, 0, 300000),
    priceMax: number(input.priceMax, 0, 300000),
    fuelTypes: list(input.fuelTypes).map(item => item.toLowerCase()),
    bodyStyles: list(input.bodyStyles),
    driveTypes: list(input.driveTypes),
    transmissions: list(input.transmissions),
    exteriorColors: list(input.exteriorColors),
    auctionTypes: list(input.auctionTypes).map(item => AUCTIONS[item.toLowerCase()]).filter(Boolean),
    // Фильтры, которых нет у bid.cars (09.10): продавец, повреждение, тип продажи, окно торгов.
    sellerMode: SELLER_MODES.includes(text(input.sellerMode)) ? text(input.sellerMode) : null,
    damageMode: DAMAGE_MODES.includes(text(input.damageMode)) ? text(input.damageMode) : null,
    saleType: SALE_TYPES.includes(text(input.saleType)) ? text(input.saleType) : null,
    saleWindowDays: number(input.saleWindowDays, 1, 30),
    // Слишком большое число лотов не ошибка: просто ограничиваем двадцатью.
    maxResults: Math.min(20, Math.max(1, Math.round(Number(input.maxResults)) || 10)),
  };

  const bad = (field, label) => {
    if (Number.isNaN(filters[field]))
      errors.push({ field, message: `${label}: неверное значение` });
  };

  bad("yearFrom", "Год от");
  bad("yearTo", "Год до");
  bad("mileageMin", "Пробег от");
  bad("mileageMax", "Пробег до");
  bad("priceMin", "Бюджет от");
  bad("priceMax", "Бюджет до");
  bad("saleWindowDays", "Окно торгов");

  if (!filters.make)
    errors.push({ field: "make", message: "Выберите марку" });

  if (filters.fuelTypes.some(item => !FUELS.includes(item)))
    errors.push({ field: "fuelTypes", message: "Топливо: выберите из списка" });

  if (filters.yearFrom !== null && filters.yearTo !== null && filters.yearFrom > filters.yearTo)
    errors.push({ field: "yearTo", message: "Год «до» не может быть раньше года «от»" });

  if (filters.priceMin !== null && filters.priceMax !== null && filters.priceMin > filters.priceMax)
    errors.push({ field: "priceMax", message: "Бюджет «до» не может быть меньше бюджета «от»" });

  if (filters.mileageMin !== null && filters.mileageMax !== null && filters.mileageMin > filters.mileageMax)
    errors.push({ field: "mileageMax", message: "Пробег «до» не может быть меньше пробега «от»" });

  // Поиск по всей марке без модели и без узких годов вернёт случайные 50 лотов из сотен.
  const years = filters.yearFrom !== null && filters.yearTo !== null ? filters.yearTo - filters.yearFrom : null;

  if (filters.make && !filters.models.length && !filters.trims.length && !(years !== null && years <= 3))
    errors.push({ field: "models", message: "Укажите модель или узкий диапазон годов (до четырёх лет): иначе поиск покажет случайные лоты марки" });

  // Незаданные поля не передаём: поиск различает «нет» и «ноль».
  const options = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== null && !(Array.isArray(value) && !value.length)));

  return { ok: errors.length === 0, errors, filters: options };
};

module.exports = { AUCTIONS, FUELS, sanitizeFilters };
