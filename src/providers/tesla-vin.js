/*
 * Комплектация Tesla по VIN (решение Mikita 07.10.2026). Бесплатный сервис
 * NHTSA vPIC отдаёт у Tesla то, что важно для цены: число моторов, привод и
 * иногда ёмкость батареи. Чего он не отдаёт — поле Trim почти всегда пустое,
 * а у Model 3/Y пишет «Standard / Performance» одной строкой.
 *
 * Поэтому три уровня уверенности:
 *   plaid       — Model S/X с тремя моторами (Tri Motor) или с «Plaid» в ответе;
 *   performance — "yes" только если в ответе подтверждено «Performance»;
 *                 «Standard / Performance» и «Non-Performance» — не Performance;
 *   батарея     — как есть из ответа, без догадок: у новых машин её обычно нет.
 *
 * Расшифровка одного VIN не меняется, поэтому ответ хранится бессрочно.
 */
const fs = require("fs");
const path = require("path");
const { decodeBatch } = require("../rare/vin-decode");

const BATCH_SIZE = 50;

const isVin = vin => /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(vin || ""));

const motorsOf = (text) => {
  if (/tri[\s-]*motor/i.test(text))
    return "tri";
  if (/dual[\s-]*motor/i.test(text))
    return "dual";
  if (/single[\s-]*motor/i.test(text))
    return "single";
  return null;
};

/*
 * Performance — только подтверждённый. «Standard / Performance» у Model 3/Y с
 * одним мотором ничего не доказывает (Performance — двухмоторная версия), а
 * «Non-Performance» прямо говорит обратное. Такие случаи — не Performance.
 */
const performanceOf = (text) => {
  if (!/performance/i.test(text) || /non[-\s]*performance|standard\s*\/\s*performance|performance\s*\/\s*standard/i.test(text))
    return null;

  return "yes";
};

// Версия разбора: записи старее перечитываются, чтобы исправление дошло до сохранённых VIN.
const PARSER_VERSION = 3;

/*
 * Топливо по ответу NHTSA: от него зависит акциз в Польше и пошлина/НДС
 * в Беларуси. Гибрид и электро различаем по уровню электрификации.
 */
const fuelOf = (result) => {
  const level = String(result.ElectrificationLevel || "");
  const fuel = String(result.FuelTypePrimary || "");

  if (/BEV|battery electric/i.test(level) || /^electric$/i.test(fuel))
    return "electric";
  if (/PHEV|plug-in/i.test(level))
    return "phev";
  if (/HEV|hybrid|mild/i.test(level) || /hybrid/i.test(fuel))
    return "hybrid";
  if (/diesel/i.test(fuel))
    return "diesel";
  if (/gasoline|flex|e85|natural gas|compressed|gas/i.test(fuel))
    return "gasoline";
  return null;
};

const numberOrNull = (value) => {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : null;
};

const parseResult = (result) => {
  if (!result || !result.Make)
    return { ok: false, parserVersion: PARSER_VERSION, checkedAt: new Date().toISOString() };

  const isTesla = /tesla/i.test(result.Make);
  const general = {
    ok: true,
    parserVersion: PARSER_VERSION,
    checkedAt: new Date().toISOString(),
    // Сам ответ сервиса с чистой расшифровкой (ErrorCode 0) надёжнее, чем с предупреждениями.
    clean: String(result.ErrorCode || "").startsWith("0"),
    make: result.Make || null,
    model: String(result.Model || ""),
    year: Number(result.ModelYear) || null,
    // Комплектация из VIN («TRX», «Raptor», «Sport»): подтверждённый источник, когда площадка её не называет.
    trim: [result.Trim, result.Series].filter(Boolean).join(" · ") || null,
    fuel: fuelOf(result),
    displacementL: numberOrNull(result.DisplacementL),
    horsepower: numberOrNull(result.EngineHP),
    cylinders: numberOrNull(result.EngineCylinders),
    drive: /awd|all-wheel|4wd|4x4|four-wheel/i.test(result.DriveType || "") ? "awd" : /rwd|rear/i.test(result.DriveType || "") ? "rwd" : /fwd|front/i.test(result.DriveType || "") ? "fwd" : null,
    body: result.BodyClass || null,
  };

  if (!isTesla)
    return { ...general, plaid: false, performance: null, motors: null, batteryKWh: null };

  const engine = [result.OtherEngineInfo, result.EVDriveUnit].filter(Boolean).join(" ");
  const bigCar = /model\s*[sx]\b/i.test(general.model);
  const motors = motorsOf(engine);
  const battery = Number(result.BatteryKWh);

  return {
    ...general,
    motors,
    drive: general.drive === "fwd" ? null : general.drive,
    batteryKWh: Number.isFinite(battery) && battery > 0 ? battery : null,
    plaid: bigCar && (motors === "tri" || /plaid/i.test(`${engine} ${result.Trim || ""} ${result.Series || ""}`)),
    performance: performanceOf(`${engine} ${result.Trim || ""}`),
    engineInfo: result.OtherEngineInfo || null,
    // 8-й символ VIN у Model S/X: «6» у Plaid-партий, «5» у остальных — только для проверки глазами.
    vinMotorCode: String(result.VIN || "").charAt(7) || null,
  };
};

class TeslaVinInfo {
  constructor(options = {}) {
    this.cacheFile = options.cacheFile || path.join(process.cwd(), "data", "vin-info-cache.json");
    this.fetchImpl = options.fetchImpl || fetch;
    this.cache = this.readCache();
    this.pending = null;
  }

  readCache() {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
    } catch {
      return {};
    }
  }

  writeCache() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const temp = `${this.cacheFile}.tmp`;

      fs.writeFileSync(temp, JSON.stringify(this.cache), "utf8");
      fs.renameSync(temp, this.cacheFile);
    } catch (error) {
      console.error("Кэш VIN не записан:", error.message);
    }
  }

  // Только то, что уже в кэше: без сети, годится для ответов, которые нельзя задерживать.
  peek(vin) {
    const entry = isVin(vin) ? this.cache[String(vin).toUpperCase()] : null;

    return entry && entry.parserVersion === PARSER_VERSION ? entry : null;
  }

  /*
   * Расшифровать все ещё не известные VIN партиями. Сбой сети ничего не
   * ломает и ничего не запоминает: следующий вызов попробует снова.
   */
  async ensure(vins) {
    const todo = [...new Set((vins || []).filter(isVin).map(vin => String(vin).toUpperCase()))]
      .filter(vin => !this.peek(vin));

    for (let start = 0; start < todo.length; start += BATCH_SIZE) {
      const batch = todo.slice(start, start + BATCH_SIZE);

      try {
        const results = await decodeBatch(batch, this.fetchImpl);

        for (const vin of batch)
          this.cache[vin] = parseResult(results.get(vin));
      } catch (error) {
        console.error("NHTSA недоступен:", error.message);
        break;
      }
    }

    if (todo.length)
      this.writeCache();

    return this;
  }

  async get(vin) {
    await this.ensure([vin]);

    return this.peek(vin);
  }
}

let shared = null;

const getVinInfo = () => {
  if (!shared)
    shared = new TeslaVinInfo();

  return shared;
};

module.exports = { TeslaVinInfo, getVinInfo, isVin, parseResult };
