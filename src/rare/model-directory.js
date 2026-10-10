const { DIRECTORY, MAKE_ALIASES } = require("./model-directory-data");

/*
 * Справочник моделей и поколений (10.10.2026, решение Mikita: рейтинг «что дорожает» нельзя строить на автоматическом разборе
 * названий — «Porsche 911» смешивал все поколения, а «380SL», «450SL» и «560 SL» считались разными моделями).
 *
 *   марка → линейка (family) → поколения (по годам и по шифру в названии) → комплектация (остаток названия).
 *
 * Порядок источников при определении (план беты, этап 1, п. 4): шифр в названии → годы выпуска → то, что называет сама площадка.
 * Справочник описывает не все машины, а те, что дают основной объём продаж (≈300 линеек); остальные остаются на
 * автоматическом разборе и помечены как «вне справочника» (listed: false). Недостающую модель добавляет администратор
 * по заявке пользователя — файл data/rare/model-directory-extra.json (тот же вид, что и DIRECTORY) подмешивается при загрузке.
 */

const norm = text => String(text || "")
  .toLowerCase()
  .replace(/[‐-―]/g, "-")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9.+\-\/ ]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const makeKey = make => norm(make).replace(/[\s-]+/g, "");

/* Собирает справочник из данных: { make, families: [{ name, match, gens: [...] }] }. Допускает дополнения (extra) от администратора. */
const buildDirectory = (data = DIRECTORY, extra = []) => {
  const byMake = new Map();
  for (const entry of [...data, ...extra]) {
    const key = makeKey(entry.make);
    const existing = byMake.get(key);
    const families = entry.families.map(family => ({
      ...family,
      match: family.match instanceof RegExp ? family.match : new RegExp(family.match, "i"),
      exclude: family.exclude ? (family.exclude instanceof RegExp ? family.exclude : new RegExp(family.exclude, "i")) : null,
      gens: (family.gens || []).map(gen => ({
        ...gen,
        code: gen.code ? (gen.code instanceof RegExp ? gen.code : new RegExp(gen.code, "i")) : null,
        when: gen.when ? (gen.when instanceof RegExp ? gen.when : new RegExp(gen.when, "i")) : null,
      })),
    }));
    if (existing)
      existing.families.unshift(...families); // дополнения администратора идут первыми — они точнее
    else
      byMake.set(key, { make: entry.make, families });
  }
  return byMake;
};

/* Поколение: шифр в названии главнее, затем годы выпуска (с условием «when», если у поколения есть своё имя в названии). */
const generationOf = (family, text, year) => {
  for (const gen of family.gens) {
    if (gen.code && gen.code.test(text))
      return gen;
  }
  if (typeof year !== "number")
    return null;
  for (const gen of family.gens) {
    if (year >= gen.from && year <= gen.to && (!gen.when || gen.when.test(text)))
      return gen;
  }
  return null;
};

/* Остаток названия после линейки и шифров поколений — комплектация («Carrera 4S», «Turbo», «GT3 RS»); регистр как в названии. */
const trimOf = (family, model, make) => {
  let rest = ` ${String(model || "")} `;
  for (const word of String(make || "").split(/\s+/).filter(Boolean))
    rest = rest.replace(new RegExp(`(^|[\\s(])${word.replace(/[-.]/g, "\\$&")}(?=[\\s)]|$)`, "gi"), " ");
  for (const gen of family.gens) {
    if (gen.code)
      rest = rest.replace(new RegExp(gen.code.source, "gi"), " "); // шифры поколений («997.2») раньше линейки, иначе «997» из линейки 911 оставит хвост «.2»
  }
  rest = rest.replace(new RegExp(family.match.source, "gi"), " ");
  rest = rest.replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").replace(/^[\s\-–,\/.()]+|[\s\-–,\/.()]+$/g, "");
  return rest || null;
};

const makeResolver = (extra = []) => {
  const directory = buildDirectory(DIRECTORY, extra);

  /*
   * lot → { make, family, generation, generationLabel, trim, listed }.
   * Сначала ищем линейку по полю «модель» лота, потом по названию; псевдоним марки («Range Rover» как марка) приводим к настоящей.
   */
  return (lot) => {
    const aliased = MAKE_ALIASES[makeKey(lot.make)] || null;
    const make = aliased?.make || lot.make;
    const entry = directory.get(makeKey(make));
    if (!entry)
      return { make, family: null, generation: null, generationLabel: null, trim: null, listed: false };

    const modelText = norm(aliased?.prefix ? `${aliased.prefix} ${lot.model || ""}` : lot.model);
    const titleText = norm(lot.title);
    for (const text of [modelText, titleText]) {
      if (!text)
        continue;
      const family = entry.families.find(item => item.match.test(text) && !(item.exclude && item.exclude.test(text)));
      if (!family)
        continue;
      const gen = generationOf(family, `${modelText} ${titleText}`, lot.year);
      return {
        make: entry.make,
        family: family.name,
        generation: gen ? gen.id : null,
        generationLabel: gen ? (gen.label || gen.id) : null,
        trim: trimOf(family, aliased?.prefix ? `${aliased.prefix} ${lot.model || ""}` : (lot.model || lot.title), make),
        listed: true,
      };
    }
    return { make: entry.make, family: null, generation: null, generationLabel: null, trim: null, listed: false };
  };
};

/* Приводит марку-псевдоним к настоящей прямо в лоте («Range Rover» как марка → Land Rover, а «Range Rover» уходит в начало модели). */
const canonicalizeLot = (lot) => {
  const aliased = MAKE_ALIASES[makeKey(lot.make)];
  if (!aliased)
    return lot;
  if (aliased.prefix)
    lot.model = `${aliased.prefix} ${lot.model || ""}`.trim();
  lot.make = aliased.make;
  return lot;
};

/* Дополнения администратора (по заявкам пользователей): data/rare/model-directory-extra.json, формат — как у DIRECTORY, регулярки строками. */
const loadExtra = (file) => {
  try {
    const parsed = JSON.parse(require("fs").readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  }
  catch {
    return [];
  }
};

module.exports = { makeResolver, buildDirectory, generationOf, canonicalizeLot, loadExtra, norm };
