const { trimLabels } = require("../providers/trim-match");

/*
 * СЛОВАРЬ РЕЕСТРА: МАРКИ → МОДЕЛИ → КОМПЛЕКТАЦИИ
 *
 * Уточнитель запроса (Dify) должен знать, какими словами лоты названы на
 * bid.cars: «Model S», а не «S», «Plaid», а не «плэйд». Иначе он повторяет
 * ошибку пользователя — «Tesla 100D, P100D, Plaid» уходит в поиск как
 * модели и не находит ничего.
 *
 * Считаем только открытые торги: их и можно найти поиском. Покрытие
 * реестра неполное, поэтому словарь — подсказка, а не полный каталог.
 */

const clean = value => String(value || "").replace(/\s+/g, " ").trim();

// В реестре одна модель приходит и как «MODEL 3», и как «Model 3»: это одна строка словаря.
const key = value => clean(value).toLowerCase();

// Из двух написаний берём человеческое: «Model 3», а не «MODEL 3».
const nicer = (current, next) => (current && current !== current.toUpperCase() ? current : next);

// Из «Long Range», «Long Range Dual Motor» оставляем короткое: это и есть название версии.
const shortestForms = (counts) => {
  const names = [...counts.keys()];

  return names.filter(name => !names.some(other =>
    other !== name && name.toLowerCase().startsWith(`${other.toLowerCase()} `)));
};

const buildVocabulary = ({ bidCars, now = Date.now(), maxTrims = 12, maxModels = 25 }) => {
  const cache = bidCars.loadCache();
  const seen = new Set();
  const makes = new Map();

  for (const bucket of Object.values(cache.buckets || {})) {
    for (const car of bucket.vehicles || []) {
      const lot = String(car.lotNumber || "");

      if (!lot || seen.has(lot) || car.vehicleType === "non_car")
        continue;

      seen.add(lot);

      if (!car.saleDate || Date.parse(car.saleDate) <= now)
        continue;

      const make = clean(car.make);
      // В реестре у одного лота в модель попал VIN — в словаре он не нужен.
      const model = clean(clean(car.model).replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, ""));

      if (!make || !model)
        continue;

      if (!makes.has(key(make)))
        makes.set(key(make), { make, lots: 0, models: new Map() });

      const makeEntry = makes.get(key(make));

      makeEntry.make = nicer(makeEntry.make, make);
      makeEntry.lots += 1;

      if (!makeEntry.models.has(key(model)))
        makeEntry.models.set(key(model), { model, lots: 0, trims: new Map() });

      const modelEntry = makeEntry.models.get(key(model));

      modelEntry.model = nicer(modelEntry.model, model);
      modelEntry.lots += 1;

      for (const name of trimLabels(car)) {
        if (name.length < 2)
          continue;

        modelEntry.trims.set(name, (modelEntry.trims.get(name) || 0) + 1);
      }
    }
  }

  return {
    openLots: [...makes.values()].reduce((sum, entry) => sum + entry.lots, 0),
    note: "Только открытые торги из локального реестра. Покрытие неполное: отсутствие модели в словаре не значит, что её нет на bid.cars.",
    makes: [...makes.values()]
      .sort((a, b) => b.lots - a.lots)
      .map(entry => ({
        make: entry.make,
        lots: entry.lots,
        models: [...entry.models.values()]
          .sort((a, b) => b.lots - a.lots)
          .slice(0, maxModels)
          .map(model => ({
            model: model.model,
            lots: model.lots,
            trims: shortestForms(model.trims)
              .sort((a, b) => model.trims.get(b) - model.trims.get(a))
              .slice(0, maxTrims),
          })),
      })),
  };
};

module.exports = { buildVocabulary };
