const fs = require("fs");
const path = require("path");

/*
 * РЫНОЧНАЯ ЦЕНА ПО ОБЪЯВЛЕНИЯМ БЕЛАРУСИ
 *
 * Берём живые объявления исправных аналогов с auto.kufar.by и ab.onliner.by
 * по всей Беларуси и считаем медиану в долларах. Обе площадки отдают
 * объявления в JSON и сами пересчитывают цену в USD, поэтому курс BYN
 * здесь не нужен. Прокси не требуется: адрес дата-центра они пускают.
 *
 * abw.by не опрашивается: сайт целиком закрыт проверкой «подтвердите,
 * что вы человек», а обходить такие проверки мы не будем.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const KM_PER_MILE = 1.609344;

// Меньше трёх аналогов — это уже не рынок, а случайные объявления.
const MIN_ANALOGS = 3;

// Сколько ближайших аналогов со ссылками отдавать: полный список раздувает промпт.
const ANALOGS_SHOWN = 8;

const USER_AGENT
  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const ABW_NOTE
  = "abw.by не опрашивается: сайт закрыт проверкой «подтвердите, что вы человек»";

/*
 * Нам нужен исправный аналог: наша машина после ремонта будет продаваться
 * рядом с ним. Объявления «на запчасти» и «после ДТП» тянут медиану вниз.
 */
const JUNK_PATTERN
  = /запчаст|разбор|донор|аварийн|после\s*дтп|бит(ый|ая)|не\s*на\s*ходу|под\s*восстановлен|на\s*восстановлен|требует\s*ремонт|утоп/i;

// Цены дальше этого от медианы — опечатки, «платёж от 800 в месяц» и мусор.
const OUTLIER_LOW = 0.6;
const OUTLIER_HIGH = 1.6;

const normalizeName = value => String(value || "")
  .toLowerCase()
  .replace(/series/g, "серия")
  .replace(/class/g, "класс")
  .replace(/[^a-zа-яё0-9]/g, "");

/*
 * Bid.Cars пишет модель вместе с хвостом («MODEL 3 LONG RANGE»),
 * а справочники площадок — коротко. Берём самое длинное название
 * из справочника, с которого начинается модель лота.
 */
const matchByName = (items, wanted, readName) => {
  const target = normalizeName(wanted);
  let best = null;
  let bestLength = 0;

  if (!target)
    return null;

  for (const item of items || []) {
    const name = normalizeName(readName(item));

    if (name && target.startsWith(name) && name.length > bestLength) {
      best = item;
      bestLength = name.length;
    }
  }

  return best;
};

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

const median = values => quantile(values, 0.5);

const roundTo = (value, step) => Math.round(value / step) * step;

const mileageKm = (vehicle) => {
  const miles = Number(vehicle.mileage);

  return Number.isFinite(miles) && miles > 0
    ? Math.round(miles * KM_PER_MILE)
    : null;
};

class HttpClient {
  constructor(options = {}) {
    this.fetch = options.fetch || fetch;
    this.timeoutMs = options.timeoutMs || 20000;
  }

  async json(url) {
    const response = await this.fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok)
      throw new Error(`${new URL(url).host} ответил ${response.status}`);

    return response.json();
  }
}

/*
 * Справочники марок и моделей меняются редко, но меняются:
 * держим их в памяти не дольше суток.
 */
class CatalogCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  async get(key, load) {
    const entry = this.entries.get(key);

    if (entry && Date.now() - entry.at < this.ttlMs)
      return entry.value;

    const value = await load();

    this.entries.set(key, { value, at: Date.now() });

    return value;
  }
}

class KufarSource {
  constructor(http) {
    this.http = http;
    this.name = "auto.kufar.by";
    this.catalog = new CatalogCache(DAY_MS);
  }

  async findModel(make, model) {
    const brands = await this.catalog.get("brands", () => this.http.json(
      "https://api.kufar.by/catalog/v1/nodes?tag=category_2010&view=taxonomy&lang=ru"
    ));

    const brand = matchByName(brands, make, item => item.labels?.ru);

    if (!brand)
      return null;

    const models = await this.catalog.get(brand.value, () => this.http.json(
      `https://api.kufar.by/catalog/v1/nodes?tag=${brand.value}&view=taxonomy&lang=ru`
    ));

    const found = matchByName(models, model, item => item.labels?.ru);

    return found
      ? { brand: brand.value, model: found.value, label: `${brand.labels.ru} ${found.labels.ru}` }
      : null;
  }

  async search(make, model, yearFrom, yearTo) {
    const match = await this.findModel(make, model);

    if (!match)
      return { matched: false, listings: [] };

    const params = new URLSearchParams({
      cat: "2010",
      lang: "ru",
      size: "200",
      cbnd2: match.brand,
      cmdl2: match.model,
      rgd: `r:${yearFrom},${yearTo}`,
      // 1 — «с пробегом»: без новых из салона.
      cnd: "1",
    });

    const listings = [];

    for (let page = 0; page < 5; page += 1) {
      const data = await this.http.json(
        `https://api.kufar.by/search-api/v2/search/rendered-paginated?${params}`
      );

      listings.push(...(data.ads || []).map(ad => this.toListing(ad)));

      const next = (data.pagination?.pages || []).find(p => p.label === "next");

      if (!next?.token)
        break;

      params.set("cursor", next.token);
    }

    return { matched: true, label: match.label, listings };
  }

  toListing(ad) {
    const params = Object.fromEntries(
      (ad.ad_parameters || []).map(p => [p.p, p])
    );

    const mileage = Number(params.mileage?.v);

    return {
      source: this.name,
      title: ad.subject || "",
      year: Number(params.regdate?.v) || null,
      mileageKm: Number.isFinite(mileage) && mileage > 0 ? mileage : null,
      // Kufar хранит цену в центах.
      priceUsd: Number(ad.price_usd) / 100 || null,
      city: params.region?.vl || null,
      vin: params.full_vehicle_vin?.v || null,
      url: ad.ad_link,
    };
  }
}

class OnlinerSource {
  constructor(http) {
    this.http = http;
    this.name = "ab.onliner.by";
    this.catalog = new CatalogCache(DAY_MS);
  }

  async findModel(make, model) {
    const brands = await this.catalog.get("brands", () => this.http.json(
      "https://ab.onliner.by/sdapi/ab.api/manufacturers"
    ));

    const brand = matchByName(brands, make, item => item.name);

    if (!brand)
      return null;

    const details = await this.catalog.get(brand.id, () => this.http.json(
      `https://ab.onliner.by/sdapi/ab.api/manufacturers/${brand.id}`
    ));

    const found = matchByName(details.models, model, item => item.name);

    return found
      ? { brand: brand.id, model: found.id, label: `${brand.name} ${found.name}` }
      : null;
  }

  async search(make, model, yearFrom, yearTo) {
    const match = await this.findModel(make, model);

    if (!match)
      return { matched: false, listings: [] };

    const listings = [];

    for (let page = 1; page <= 5; page += 1) {
      // Onliner ждёт квадратные скобки в именах параметров как есть.
      const query = [
        `car[0][manufacturer]=${match.brand}`,
        `car[0][model]=${match.model}`,
        `year[from]=${yearFrom}`,
        `year[to]=${yearTo}`,
        // owned — «с пробегом»: без новых и без аварийных.
        "state[0]=owned",
        "limit=50",
        `page=${page}`,
      ].join("&");

      const data = await this.http.json(
        `https://ab.onliner.by/sdapi/ab.api/search/vehicles?${query}`
      );

      listings.push(...(data.adverts || []).map(advert => this.toListing(advert)));

      if (!data.page || data.page.current >= data.page.last)
        break;
    }

    return { matched: true, label: match.label, listings };
  }

  toListing(advert) {
    const odometer = advert.specs?.odometer;
    const km = odometer?.unit === "mile"
      ? odometer.value * KM_PER_MILE
      : odometer?.value;

    return {
      source: this.name,
      title: advert.title || "",
      year: advert.specs?.year || null,
      mileageKm: Number.isFinite(km) && km > 0 ? Math.round(km) : null,
      priceUsd: Number(advert.price?.converted?.USD?.amount) || null,
      city: advert.location?.city?.name || null,
      vin: null,
      url: advert.html_url,
    };
  }
}

/*
 * Одна и та же машина часто висит и на Kufar, и на Onliner, а дилер
 * бывает выставляет её дважды. Считаем её один раз, иначе у навязчивых
 * объявлений двойной вес.
 */
const isSameCar = (a, b) => {
  if (a.vin && b.vin)
    return a.vin === b.vin;

  if (a.year !== b.year || a.mileageKm === null || b.mileageKm === null)
    return false;

  // Внутри одной площадки совпадение пробега до километра — уже повтор.
  const mileageTolerance = a.source === b.source ? 0 : 2000;
  const priceTolerance = a.source === b.source ? 0.05 : 0.03;

  return Math.abs(a.mileageKm - b.mileageKm) <= mileageTolerance
    && Math.abs(a.priceUsd - b.priceUsd) <= a.priceUsd * priceTolerance;
};

const dropDuplicates = (listings) => {
  const kept = [];

  for (const listing of listings) {
    const twin = kept.find(other => isSameCar(other, listing));

    if (twin)
      twin.alsoAt = [...(twin.alsoAt || []), listing.url];
    else
      kept.push({ ...listing });
  }

  return kept;
};

const dropOutliers = (listings) => {
  if (listings.length < MIN_ANALOGS)
    return listings;

  const center = median(listings.map(l => l.priceUsd));

  return listings.filter(l =>
    l.priceUsd >= center * OUTLIER_LOW && l.priceUsd <= center * OUTLIER_HIGH
  );
};

class MinskMarketPrices {
  constructor(options = {}) {
    this.cacheFile = options.cacheFile
      || path.join(process.cwd(), "data", "market-prices-cache.json");
    this.ttlMs = options.ttlMs || DAY_MS;

    const http = options.http || new HttpClient(options);

    this.sources = options.sources || [new KufarSource(http), new OnlinerSource(http)];
    this.cache = this.readCache();
  }

  readCache() {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
    } catch {
      return {};
    }
  }

  writeCache() {
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
  }

  // Пробег округляем до 10 тыс. км: соседние лоты одной модели делят одну выборку.
  static cacheKey(vehicle) {
    const km = mileageKm(vehicle);

    return [
      normalizeName(vehicle.make),
      normalizeName(vehicle.model),
      vehicle.year,
      km === null ? "?" : Math.round(km / 10000),
    ].join("|");
  }

  async lookup(vehicle) {
    const lotNumber = vehicle.lotNumber ? String(vehicle.lotNumber) : null;
    const year = Number(vehicle.year);

    if (!vehicle.make || !vehicle.model || !Number.isInteger(year)) {
      return {
        lotNumber,
        status: "not_enough_lot_data",
        marketValueUsd: null,
        reason: "У лота не указаны марка, модель или год",
      };
    }

    const key = MinskMarketPrices.cacheKey(vehicle);
    const cached = this.cache[key];

    if (cached && Date.now() - Date.parse(cached.fetchedAt) <= this.ttlMs)
      return { lotNumber, ...cached, cached: true };

    const result = await this.collect(vehicle, year);

    // Сбой площадки не запоминаем: через минуту она может ответить.
    if (!result.errors.length) {
      this.cache[key] = result;
      this.writeCache();
    }

    return { lotNumber, ...result, cached: false };
  }

  async collect(vehicle, year) {
    const lotKm = mileageKm(vehicle);
    const errors = [];
    const matchedModels = {};
    let listings = [];

    // Год ±2 берём одним запросом, а сужаем уже у себя.
    for (const source of this.sources) {
      try {
        const found = await source.search(vehicle.make, vehicle.model, year - 2, year + 2);

        if (found.matched)
          matchedModels[source.name] = found.label;

        listings.push(...found.listings);
      } catch (error) {
        errors.push(`${source.name}: ${error.message}`);
      }
    }

    const base = {
      status: "ok",
      marketValueUsd: null,
      currency: "USD",
      priceBasis: "медиана цен объявлений исправных аналогов по всей Беларуси",
      sources: this.sources.map(s => s.name),
      matchedModels,
      lot: { make: vehicle.make, model: vehicle.model, year, mileageKm: lotKm },
      errors,
      notes: [ABW_NOTE],
      fetchedAt: new Date().toISOString(),
    };

    if (errors.length === this.sources.length)
      return { ...base, status: "source_error", reason: errors.join("; ") };

    if (!Object.keys(matchedModels).length) {
      return {
        ...base,
        status: "model_not_found",
        reason: `Модель «${vehicle.make} ${vehicle.model}» не найдена в справочниках площадок`,
      };
    }

    const found = listings.length;

    listings = listings.filter(l => l.priceUsd >= 1000 && l.year);

    const clean = listings.filter(l => !JUNK_PATTERN.test(l.title));
    const junk = listings.length - clean.length;
    const unique = dropDuplicates(clean);

    /*
     * Сначала ищем как можно ближе к лоту и расширяем, только если
     * аналогов не хватило. Уровень попадает в ответ: «±2 года, любой
     * пробег» — заметно менее надёжная цифра, чем «±1 год, похожий пробег».
     */
    const mileageWindow = lotKm === null ? null : Math.max(40000, lotKm * 0.5);

    const steps = [
      { level: "год ±1, похожий пробег", years: 1, mileage: true },
      { level: "год ±1, любой пробег", years: 1, mileage: false },
      { level: "год ±2, любой пробег", years: 2, mileage: false },
    ].filter(step => !step.mileage || mileageWindow !== null);

    let chosen = null;

    for (const step of steps) {
      const candidates = unique.filter(l =>
        Math.abs(l.year - year) <= step.years
        && (!step.mileage
          || (l.mileageKm !== null && Math.abs(l.mileageKm - lotKm) <= mileageWindow))
      );

      const analogs = dropOutliers(candidates);

      chosen = { step, analogs, outliers: candidates.length - analogs.length };

      if (analogs.length >= MIN_ANALOGS)
        break;
    }

    const { step, analogs } = chosen;
    const prices = analogs.map(l => l.priceUsd);

    const distance = l =>
      Math.abs(l.year - year) * 20000 + Math.abs((l.mileageKm ?? lotKm ?? 0) - (lotKm ?? 0));

    const summary = {
      ...base,
      match: {
        level: step.level,
        yearFrom: year - step.years,
        yearTo: year + step.years,
        mileageKmFrom: step.mileage ? Math.max(0, Math.round(lotKm - mileageWindow)) : null,
        mileageKmTo: step.mileage ? Math.round(lotKm + mileageWindow) : null,
      },
      analogsCount: analogs.length,
      bySource: Object.fromEntries(
        this.sources.map(s => [s.name, analogs.filter(l => l.source === s.name).length])
      ),
      filtered: {
        found,
        junk,
        duplicates: clean.length - unique.length,
        outliers: chosen.outliers,
      },
      closestAnalogs: [...analogs]
        .sort((a, b) => distance(a) - distance(b))
        .slice(0, ANALOGS_SHOWN)
        .map(({ vin, ...rest }) => ({ ...rest, priceUsd: Math.round(rest.priceUsd) })),
    };

    if (analogs.length < MIN_ANALOGS) {
      return {
        ...summary,
        status: "too_few_analogs",
        reason: `Нашлось аналогов: ${analogs.length}, нужно не меньше ${MIN_ANALOGS}`,
      };
    }

    return {
      ...summary,
      marketValueUsd: roundTo(median(prices), 50),
      rangeUsd: {
        min: Math.round(Math.min(...prices)),
        p25: roundTo(quantile(prices, 0.25), 50),
        p75: roundTo(quantile(prices, 0.75), 50),
        max: Math.round(Math.max(...prices)),
      },
    };
  }
}

module.exports = {
  MinskMarketPrices,
  KufarSource,
  OnlinerSource,
  matchByName,
  normalizeName,
  MIN_ANALOGS,
};
