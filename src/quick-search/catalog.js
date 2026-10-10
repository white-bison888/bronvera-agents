/*
 * Справочник марок и моделей для формы быстрого поиска: собирается из того, что
 * наш реестр лотов уже видел на bid.cars (названия там нужны дословно — по ним
 * строится адрес поиска), плюс короткий список псевдонимов для популярных машин,
 * которые люди называют не так, как bid.cars: TRX, Raptor, Plaid.
 */
const KEEP_UPPER = new Set(["BMW", "GMC", "RAM", "MG", "KIA", "BYD", "MINI", "FIAT"]);

const display = (name) => {
  const value = String(name || "").trim();

  if (!value)
    return "";
  if (KEEP_UPPER.has(value.toUpperCase()))
    return value.toUpperCase();
  // «TESLA» → «Tesla», «MODEL 3» → «Model 3», «F-150» остаётся.
  if (value === value.toUpperCase() && /[A-Z]{4,}/.test(value))
    return value.split(" ").map(word => (/[A-Z]{4,}/.test(word) ? word[0] + word.slice(1).toLowerCase() : word)).join(" ");

  return value;
};

// Русские названия марок: люди пишут «бмв», а в справочнике bid.cars — BMW.
const CYRILLIC_MAKES = {
  бмв: "BMW", тесла: "Tesla", форд: "Ford", тойота: "Toyota", хонда: "Honda", шевроле: "Chevrolet",
  мерседес: "Mercedes-Benz", ауди: "Audi", порше: "Porsche", ниссан: "Nissan", хендай: "Hyundai",
  хёндай: "Hyundai", киа: "Kia", додж: "Dodge", джип: "Jeep", лексус: "Lexus", мазда: "Mazda",
  субару: "Subaru", фольксваген: "Volkswagen", вольво: "Volvo", рам: "RAM", кадиллак: "Cadillac",
  линкольн: "Lincoln", шевроле: "Chevrolet", инфинити: "Infiniti", митсубиси: "Mitsubishi",
};

const ALIASES = [
  { words: ["trx"], make: "RAM", models: ["1500"], trims: ["TRX"], hint: "RAM 1500 TRX" },
  { words: ["raptor"], make: "Ford", models: ["F-150"], trims: ["Raptor"], hint: "Ford F-150 Raptor" },
  { words: ["plaid"], make: "Tesla", models: ["Model S", "Model X"], trims: ["Plaid"], hint: "Tesla Model S/X Plaid" },
  { words: ["cybertruck", "киберт"], make: "Tesla", models: ["Cybertruck"], trims: [], hint: "Tesla Cybertruck" },
  { words: ["m5", "м5"], make: "BMW", models: ["M5"], trims: [], hint: "BMW M5" },
  { words: ["m3", "м3"], make: "BMW", models: ["M3"], trims: [], hint: "BMW M3" },
  { words: ["dodge ram", "додж рам"], make: "RAM", models: ["1500"], trims: [], hint: "С 2010 года Ram — отдельная марка, не Dodge" },
];

/*
 * В реестре встречаются обрезки и склейки с VIN («Model», «MDL», «Y», «Model 3 5YJ3E1…»):
 * в выпадающий список такие названия не должны попадать. Настоящая модель коротка и встречается не раз.
 */
const JUNK_MODEL = /[A-HJ-NPR-Z0-9]{17}|^(model|mdl|y|x|s|3)$/i;

const buildCatalog = (vehicles = []) => {
  const makes = new Map();

  for (const vehicle of vehicles) {
    const make = display(vehicle.make);
    const model = display(vehicle.model);

    if (!make || !model)
      continue;

    const entry = makes.get(make.toLowerCase()) || { make, models: new Map(), count: 0 };

    entry.count += 1;

    const modelKey = model.toLowerCase();
    const known = entry.models.get(modelKey) || { model, count: 0 };

    known.count += 1;
    entry.models.set(modelKey, known);
    makes.set(make.toLowerCase(), entry);
  }

  return {
    makes: [...makes.values()]
      .sort((a, b) => b.count - a.count)
      .map(entry => ({
        make: entry.make,
        count: entry.count,
        models: [...entry.models.values()]
          .filter(item => !JUNK_MODEL.test(item.model) && item.model.length >= 2)
          .sort((a, b) => b.count - a.count),
      })),
    aliases: ALIASES,
  };
};

module.exports = { ALIASES, CYRILLIC_MAKES, buildCatalog, display };
