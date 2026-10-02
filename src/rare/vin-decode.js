/*
 * Расшифровка VIN (02.10.2026, просьба Mikita): у настоящего 17-знакового VIN
 * (машины с 1981 года) бесплатный государственный сервис США NHTSA vPIC отдаёт
 * марку, модель, год, поколение, кузов, двигатель (цилиндры, объём, расположение,
 * наддув, мощность), привод (не всегда), страну завода. Цвета, пробега, опций и
 * надёжной коробки там нет, а у европейских машин расшифровка часто неполная —
 * поэтому данные из VIN только дополняют лот и проверяются на совпадение марки.
 */
const VPIC_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesBatch/";
const BATCH_SIZE = 50;

const BODY_BY_CLASS = [
  [/convertible|cabriolet/i, "Кабриолет"],
  [/roadster/i, "Родстер"],
  [/coupe/i, "Купе"],
  [/wagon/i, "Универсал"],
  [/pickup/i, "Пикап"],
  [/sport utility|suv|multi-purpose/i, "Внедорожник"],
  [/hatchback|liftback|notchback/i, "Хэтчбек"],
  [/sedan|saloon/i, "Седан"],
  [/van|minivan|bus/i, "Фургон"],
];

const normalizeMake = text => String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* «Chevrolet» / «CHEVROLET», «Mercedes-Benz» / «MERCEDES-BENZ» / «Mercedes Benz Trucks» — совпадением считаем вложение. */
const sameMake = (lotMake, decodedMake) => {
  const a = normalizeMake(lotMake);
  const b = normalizeMake(decodedMake);
  return Boolean(a) && Boolean(b) && (a.includes(b) || b.includes(a));
};

const driveOf = (type) => {
  const text = String(type || "");
  if (/awd|all-wheel|4wd|4x4|four-wheel/i.test(text))
    return "Полный";
  if (/rwd|rear/i.test(text))
    return "Задний";
  if (/fwd|front/i.test(text))
    return "Передний";
  return null;
};

const layoutOf = (configuration) => {
  const text = String(configuration || "");
  if (/v-shaped|^v\b/i.test(text))
    return "V";
  if (/w-shaped/i.test(text))
    return "W";
  if (/in-line|inline|straight/i.test(text))
    return "Рядный";
  if (/opposed|flat|boxer/i.test(text))
    return "Оппозитный";
  if (/rotary/i.test(text))
    return "Роторный";
  return null;
};

const fillIfEmpty = (lot, key, value) => {
  if (value === null || value === undefined || value === "")
    return 0;
  if (lot[key] === null || lot[key] === undefined) {
    lot[key] = value;
    return 1;
  }
  return 0;
};

/*
 * Применить ответ vPIC к лоту. Двигатель (цилиндры, объём, расположение) из чистой
 * расшифровки (ErrorCode 0) точнее догадки по тексту — перезаписываем; остальное
 * только дописываем. Если марка из VIN не совпала с маркой лота — VIN нам не верим
 * (опечатка продавца или чужая запись): помечаем лот проверенным и ничего не берём.
 */
const applyDecoded = (lot, result, now = Date.now()) => {
  lot.vinCheckedAt = new Date(now).toISOString();
  // Повторная расшифровка начинается с чистого листа: отметки о происхождении данных пересчитываем.
  delete lot.vinFields;
  delete lot.vinInfo;
  delete lot.vinCheck;

  if (!result || !result.Make) {
    lot.vinDecoded = false;
    return 0;
  }
  if (!sameMake(lot.make, result.Make)) {
    lot.vinDecoded = false;
    lot.vinMismatch = result.Make;
    return 0;
  }

  delete lot.vinMismatch;
  lot.vinDecoded = true;
  const clean = /^0\b/.test(String(result.ErrorCode || ""));
  let changed = 0;

  const cylinders = Number(result.EngineCylinders);
  const displacement = Math.round(Number(result.DisplacementL) * 10) / 10;
  const layout = layoutOf(result.EngineConfiguration);

  /*
   * Что именно дала расшифровка (vinFields) — чтобы сайт отметил эти поля «по VIN»; что расшифровка
   * утверждает о самой машине (vinInfo) — марка, модель, год, версия, завод; и где она расходится с
   * тем, что написано в лоте (vinCheck) — год, объём двигателя, число цилиндров.
   */
  const vinFields = [];
  const mark = (key, value) => {
    if (value !== null && value !== undefined && value !== "" && !(typeof value === "number" && !Number.isFinite(value)))
      vinFields.push(key);
  };
  mark("cylinders", Number.isFinite(cylinders) && cylinders > 0 ? cylinders : null);
  mark("displacement", Number.isFinite(displacement) && displacement > 0 ? displacement : null);
  mark("engineLayout", layout);
  mark("bodyStyle", (BODY_BY_CLASS.find(([pattern]) => pattern.test(String(result.BodyClass || ""))) || [])[1]);
  mark("drivetrain", driveOf(result.DriveType));
  mark("aspiration", String(result.Turbo || "").toLowerCase() === "yes" ? "Турбо" : null);
  mark("generation", String(result.Series || "").replace(/^Type\s+/i, "") || null);
  mark("hp", Number(result.EngineHP) > 0 ? Number(result.EngineHP) : null);
  mark("plantCountry", String(result.PlantCountry || "").trim() || null);

  const info = {
    make: result.Make,
    model: result.Model || null,
    year: Number(result.ModelYear) > 1980 ? Number(result.ModelYear) : null,
    trim: String(result.Trim || "").trim() || null,
    series: String(result.Series || "").trim() || null,
    plant: String(result.PlantCountry || "").trim() || null,
    fuel: String(result.FuelTypePrimary || "").trim() || null,
    clean,
  };
  lot.vinInfo = Object.fromEntries(Object.entries(info).filter(([, value]) => value !== null));

  const check = [];
  // Модельный год по VIN и год в названии часто различаются на единицу (машину продали в следующем календарном году) — это не ошибка; от двух лет — отмечаем.
  if (info.year && typeof lot.year === "number" && Math.abs(info.year - lot.year) >= 2)
    check.push({ field: "year", lot: lot.year, vin: info.year });
  if (clean && Number.isFinite(displacement) && displacement > 0 && typeof lot.displacement === "number" && Math.abs(lot.displacement - displacement) > 0.15)
    check.push({ field: "displacement", lot: lot.displacement, vin: displacement });
  if (clean && Number.isFinite(cylinders) && cylinders > 0 && typeof lot.cylinders === "number" && lot.cylinders !== cylinders)
    check.push({ field: "cylinders", lot: lot.cylinders, vin: cylinders });
  if (check.length)
    lot.vinCheck = check;

  if (clean) {
    if (Number.isFinite(cylinders) && cylinders > 0 && lot.cylinders !== cylinders) {
      lot.cylinders = cylinders;
      changed += 1;
    }
    if (Number.isFinite(displacement) && displacement > 0 && lot.displacement !== displacement) {
      lot.displacement = displacement;
      changed += 1;
    }
    if (layout && lot.engineLayout !== layout) {
      lot.engineLayout = layout;
      changed += 1;
    }
  }
  else {
    changed += fillIfEmpty(lot, "cylinders", Number.isFinite(cylinders) && cylinders > 0 ? cylinders : null);
    changed += fillIfEmpty(lot, "displacement", Number.isFinite(displacement) && displacement > 0 ? displacement : null);
    changed += fillIfEmpty(lot, "engineLayout", layout);
  }

  const body = (BODY_BY_CLASS.find(([pattern]) => pattern.test(String(result.BodyClass || ""))) || [])[1];
  changed += fillIfEmpty(lot, "bodyStyle", body);
  changed += fillIfEmpty(lot, "drivetrain", driveOf(result.DriveType));
  changed += fillIfEmpty(lot, "aspiration", String(result.Turbo || "").toLowerCase() === "yes" ? "Турбо" : null);
  changed += fillIfEmpty(lot, "generation", String(result.Series || "").replace(/^Type\s+/i, "") || null);
  changed += fillIfEmpty(lot, "vinTrim", String(result.Trim || "").trim() || null);
  changed += fillIfEmpty(lot, "hp", Number(result.EngineHP) > 0 ? Number(result.EngineHP) : null);
  changed += fillIfEmpty(lot, "plantCountry", String(result.PlantCountry || "").trim() || null);
  changed += fillIfEmpty(lot, "year", Number(result.ModelYear) > 1980 ? Number(result.ModelYear) : null);

  if (vinFields.length)
    lot.vinFields = vinFields;

  return changed;
};

const decodeBatch = async (vins, fetchImpl) => {
  const response = await fetchImpl(VPIC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ format: "json", data: vins.join(";") }).toString(),
  });
  if (!response.ok)
    throw new Error(`NHTSA ответил ${response.status}`);
  const body = await response.json();
  return new Map((body.Results || []).map(result => [String(result.VIN || "").toUpperCase(), result]));
};

/* Расшифровывает VIN всех лотов из списка, которых ещё не проверяли; партиями по 50. */
const enrichWithVinDecode = async ({
  lots,
  save,
  fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  delayMs = 1000,
  log = () => {},
  force = false, // пересчитать и уже проверенные (например, после изменения того, что храним)
}) => {
  const todo = lots.filter(lot => lot.vin && (force || !lot.vinCheckedAt));
  let checked = 0;
  let changed = 0;

  for (let start = 0; start < todo.length; start += BATCH_SIZE) {
    const batch = todo.slice(start, start + BATCH_SIZE);
    const results = await decodeBatch(batch.map(lot => lot.vin), fetchImpl);
    for (const lot of batch)
      changed += applyDecoded(lot, results.get(lot.vin), now());
    checked += batch.length;
    if ((start / BATCH_SIZE) % 20 === 19) {
      save();
      log(`BRONVERA Rare: расшифровано VIN ${checked}/${todo.length}, изменено полей ${changed}`);
    }
    await sleep(delayMs);
  }

  save();
  return { checked, changed };
};

module.exports = { applyDecoded, decodeBatch, enrichWithVinDecode, sameMake };
