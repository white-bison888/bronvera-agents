const fs = require("fs");
const { engineLabel, flagsOf, isLowMileage, isNotCar } = require("./sold-attrs");
const { buildFamilyResolver } = require("./model-family");

/*
 * Индекс проданных лотов для вкладки Stats (02.10.2026). Архивов уже
 * десятки тысяч лотов, и отдавать сайту каждый целиком (с названием, ссылками
 * и фото — около 700 байт) нельзя: ответ через Vercel не может быть больше
 * ~4,5 МБ, а графикам и фильтрам эти поля не нужны. Поэтому два вида ответа:
 *
 *   points  — компактные строки-массивы только с тем, что нужно графикам,
 *             фильтрам и сводке (цена, дата, марка, модель, год, пробег,
 *             коробка, цвет), повторяющиеся слова — через словари;
 *   lotsByIds — полные записи для строк списка на экране и выгрузки в CSV.
 *
 * Индекс пересобирается только когда меняется файл любого архива.
 */

/*
 * Порядок первых 11 колонок не меняем — по ним читает уже выложенный сайт.
 * Колонка «model» теперь несёт линейку (family: «911», «Grand Cherokee»), а
 * остаток названия — комплектация — идёт отдельной колонкой trim (см.
 * model-family.js). Новые колонки только в конце.
 */
const POINT_FIELDS = ["id", "soldAt", "salePrice", "source", "make", "model", "year", "mileage", "transmission", "color", "sold", "body", "engine", "drive", "trim", "generation", "resale", "flags"];
const TRANSMISSION_CODES = { manual: 1, automatic: 2 };

/* Всё, что страница ждёт от лота, — с пустыми значениями по умолчанию (старые записи архива их не имеют). */
const fullLot = lot => ({
  estimateMin: null,
  estimateMax: null,
  mileage: null,
  transmission: null,
  transmissionKind: null,
  exteriorColor: null,
  colorGroup: null,
  conditionFacts: [],
  photoUrl: null,
  year: null,
  model: null,
  sold: null,
  ...lot,
  lowMileage: isLowMileage(lot), // относительный: считается по пробегу и возрасту
});

/*
 * Ключ «одной и той же машины» для отслеживания перепродаж: настоящий VIN либо
 * номер шасси вместе с маркой (у старых машин VIN нет, но номер шасси уникален
 * внутри марки). Слишком короткие и пустые номера не берём — по ним нельзя
 * отличить одну машину от другой.
 */
const resaleKeyOf = (lot) => {
  if (lot.vin)
    return `vin:${lot.vin}`;
  const chassis = String(lot.chassis || "").replace(/[\s-]+/g, "").toUpperCase();
  if (chassis.length >= 6 && /\d/.test(chassis) && lot.make)
    return `ch:${String(lot.make).toLowerCase()}:${chassis}`;
  return null;
};

/*
 * Насколько надёжно известно, что это за машина и встречалась ли она на других площадках.
 * Уровень зависит только от идентификатора (VIN или номер шасси), результата его расшифровки и числа записей об этой машине;
 * ничего не угадывается по пробегу или цвету.
 *   multi — тот же VIN/шасси найден на двух и более площадках; repeat — продавалась несколько раз на одной;
 *   decoded — VIN есть и расшифрован, других записей нет; undecoded — VIN есть, расшифровка ничего не дала;
 *   chassis — только номер шасси (ищем среди лотов той же марки); weak — номер слишком короткий для поиска; none — идентификатора нет;
 *   conflict — VIN называет другую марку; inconsistent — под одним номером оказались лоты с годами, различающимися больше чем на два.
 */
const identityOf = (lot, group = []) => {
  const peers = group.length ? group : [lot];
  const via = lot.vin ? "vin" : (resaleKeyOf(lot) ? "chassis" : null);
  const sources = [...new Set(peers.map(peer => peer.source).filter(Boolean))];
  const checks = Array.isArray(lot.vinCheck) ? lot.vinCheck.length : 0;
  const base = { via, sales: peers.length, sources, checks };
  if (lot.vinMismatch)
    return { ...base, level: "conflict" };
  if (!via)
    return { ...base, level: lot.chassis ? "weak" : "none" };
  if (peers.length >= 2) {
    // Марки не сравниваем: у одной машины они бывают разными (Ford и Shelby, Mercedes-Benz и Mercedes-AMG); VIN главнее. Годы — да.
    const years = peers.map(peer => peer.year).filter(year => typeof year === "number");
    if (years.length > 1 && Math.max(...years) - Math.min(...years) > 2)
      return { ...base, level: "inconsistent" };
    return { ...base, level: sources.length >= 2 ? "multi" : "repeat" };
  }
  if (via === "chassis")
    return { ...base, level: "chassis" };
  return { ...base, level: lot.vinDecoded ? "decoded" : "undecoded" };
};

/*
 * Повторные торги — не перепродажа: если машина снова ушла с молотка на той же площадке меньше чем через 45 дней
 * (покупатель не выкупил, резерв не достигнут и лот выставили заново), настоящей считаем только последнюю запись.
 * Перепродажа на другой площадке остаётся перепродажей даже за неделю.
 */
const RELIST_DAYS = 45;
const collapseRelists = (members) => {
  const kept = [];
  for (const lot of [...members].sort((a, b) => Date.parse(a.soldAt) - Date.parse(b.soldAt))) {
    const last = kept[kept.length - 1];
    if (last && last.source === lot.source && Date.parse(lot.soldAt) - Date.parse(last.soldAt) < RELIST_DAYS * 86400_000)
      kept[kept.length - 1] = lot;
    else
      kept.push(lot);
  }
  return kept;
};

/*
 * Особенности лота битами (см. FLAG_RULES в sold-attrs.js): 1 доработана, 2 проект, 4 оригинал,
 * 8 реставрирована, 16 один владелец, 32 особая версия, 64 малый пробег (считается по пробегу и возрасту).
 */
/* Комплектации совпадают, если одна содержится в другой («50th Anniversary Edition» и «50th Anniversary Edition - Manual») или почти целиком пересекаются по словам. */
const normalizeTrim = text => String(text || "").toLowerCase().replace(/[^a-z0-9а-я.]+/g, " ").trim();
const sameTrim = (a, b) => {
  const x = normalizeTrim(a);
  const y = normalizeTrim(b);
  if (!x || !y)
    return false;
  if (x === y || x.includes(y) || y.includes(x))
    return true;
  const wx = new Set(x.split(" "));
  const wy = new Set(y.split(" "));
  const shared = [...wx].filter(word => wy.has(word)).length;
  return shared / Math.max(wx.size, wy.size) >= 0.6;
};

const FLAG_BITS = { modified: 1, project: 2, unrestored: 4, restored: 8, oneOwner: 16, special: 32 };
const LOW_MILEAGE_BIT = 64;

const flagMask = (lot) => {
  let mask = 0;
  for (const code of lot.flags || [])
    mask |= FLAG_BITS[code] || 0;
  if (isLowMileage(lot))
    mask |= LOW_MILEAGE_BIT;
  return mask;
};

const conditionOf = (lot) => {
  const flags = lot.flags || [];
  if (flags.includes("project"))
    return "project";
  if (flags.includes("unrestored"))
    return "unrestored";
  if (flags.includes("restored"))
    return "restored";
  return null;
};

const CONDITION_LABELS = { project: "проект", unrestored: "оригинал", restored: "реставрирована" };

const signatureOf = (files) => {
  return files.map((file) => {
    try {
      const { mtimeMs, size } = fs.statSync(file);
      return `${file}:${mtimeMs}:${size}`;
    }
    catch {
      return `${file}:0`;
    }
  }).join("|");
};

class SoldIndex {
  constructor(scrapers) {
    this.scrapers = scrapers;
    this.signature = null;
    this.lots = [];
    this.byId = new Map();
  }

  refresh() {
    const sources = this.scrapers.filter(scraper => typeof scraper.readSold === "function" && typeof scraper.soldFile === "function");
    const signature = signatureOf(sources.map(scraper => scraper.soldFile()));
    if (signature === this.signature)
      return;

    const lots = sources
      .flatMap(scraper => scraper.readSold())
      .filter(lot => lot && lot.soldAt && typeof lot.salePrice === "number" && !isNotCar(lot))
      .sort((a, b) => Date.parse(b.soldAt) - Date.parse(a.soldAt));

    // Особенности по названию — для лотов, у которых архив их ещё не посчитал (например, Bring a Trailer, пока идёт
    // добор страниц и архив занят). Объекты лежат в кэше чтения, на сами файлы это не влияет.
    for (const lot of lots) {
      if (!Array.isArray(lot.flags)) {
        const found = flagsOf(lot.title);
        if (found.length)
          lot.flags = found;
      }
    }

    this.lots = lots;
    this.byId = new Map(lots.map(lot => [lot.id, lot]));
    this.resolveFamily = buildFamilyResolver(lots);

    // Группы одной и той же машины, проданной не раз: id лота → номер группы.
    const byKey = new Map();
    for (const lot of lots) {
      const key = resaleKeyOf(lot);
      if (!key)
        continue;
      const list = byKey.get(key);
      if (list)
        list.push(lot);
      else
        byKey.set(key, [lot]);
    }
    this.resaleGroups = [];
    this.resaleOf = new Map();
    for (const members of byKey.values()) {
      const group = collapseRelists(members);
      if (group.length < 2)
        continue;
      const index = this.resaleGroups.length;
      this.resaleGroups.push(group);
      for (const lot of group)
        this.resaleOf.set(lot.id, index);
    }

    this.signature = signature;
  }

  total() {
    this.refresh();
    return this.lots.length;
  }

  /* [since, until) в миллисекундах; null — без границы. */
  points({ since = null, until = null } = {}) {
    this.refresh();

    const dict = { source: [], make: [], model: [], color: [], body: [], engine: [], drive: [], trim: [], generation: [] };
    const lookup = { source: new Map(), make: new Map(), model: new Map(), color: new Map(), body: new Map(), engine: new Map(), drive: new Map(), trim: new Map(), generation: new Map() };
    const code = (kind, value) => {
      if (value === null || value === undefined || value === "")
        return -1;
      const known = lookup[kind].get(value);
      if (known !== undefined)
        return known;
      dict[kind].push(value);
      lookup[kind].set(value, dict[kind].length - 1);
      return dict[kind].length - 1;
    };

    const rows = [];
    for (const lot of this.lots) {
      const at = Date.parse(lot.soldAt);
      if ((since !== null && at < since) || (until !== null && at >= until))
        continue;
      const { family, trim, generation } = this.resolveFamily(lot);
      rows.push([
        lot.id,
        Math.floor(at / 1000),
        lot.salePrice,
        code("source", lot.source),
        code("make", lot.make),
        code("model", family),
        typeof lot.year === "number" ? lot.year : 0,
        typeof lot.mileage === "number" ? lot.mileage : -1,
        TRANSMISSION_CODES[lot.transmissionKind] || 0,
        code("color", lot.colorGroup),
        lot.sold === true ? 1 : (lot.sold === false ? 0 : 2),
        code("body", lot.bodyStyle),
        code("engine", engineLabel(lot)),
        code("drive", lot.drivetrain),
        code("trim", lot.trimName || trim),
        code("generation", lot.generation || generation),
        this.resaleOf.has(lot.id) ? this.resaleOf.get(lot.id) : -1,
        flagMask(lot),
      ]);
    }

    return { fields: POINT_FIELDS, dict, rows };
  }

  lotsByIds(ids) {
    this.refresh();
    return ids.map(id => this.byId.get(id)).filter(Boolean).map(fullLot);
  }

  /*
   * «Равные позиции» (просьба Mikita): с чем честно сравнивать цену этого лота. Берём продажи той же
   * линейки модели, доработанные с доработанными, особые версии с особыми, и ранжируем по близости
   * (см. compare). Сначала «такие же», если их мало — ближайшие по классу и возрасту с пометкой, чем отличаются.
   */
  comparables(id, { minExact = 5, listSize = 12 } = {}) {
    this.refresh();
    const lot = this.byId.get(id);
    if (!lot)
      return null;

    const resolved = this.resolveFamily(lot);
    const mine = { ...resolved, trim: lot.trimName || resolved.trim, generation: lot.generation || resolved.generation };
    const trimOf = other => other.trimName || this.resolveFamily(other).trim;
    const generationOf = other => other.generation || this.resolveFamily(other).generation;
    const myFlags = new Set(lot.flags || []);
    const myCondition = conditionOf(lot);

    // Та же марка и линейка. Доработанные (рестомод, реплика) с серийными не смешиваем никогда; особая версия
    // отличается от обычной сильно, но в «ближайшие» попасть может — с пометкой, если «таких же» мало.
    const hasFlag = (other, code) => (other.flags || []).includes(code);
    const pool = mine.family
      ? this.lots.filter(other => other.id !== lot.id && other.make === lot.make && other.sold !== false && typeof other.year === "number"
        && this.resolveFamily(other).family === mine.family
        && hasFlag(other, "modified") === myFlags.has("modified"))
      : [];
    const lotTitle = normalizeTrim(lot.title);

    const mileageBand = (miles) => {
      for (const [index, limit] of [5000, 10000, 25000, 50000, 75000, 100000, 150000].entries()) {
        if (miles < limit)
          return index;
      }
      return 7;
    };

    /*
     * «Такие же» и «ближайшие» (просьба Mikita 02.10): сначала машины, совпадающие по поколению,
     * комплектации, кузову, коробке, двигателю и близкие по году (до двух лет). Если их мало — к ним
     * добавляем ближайшие по классу и возрасту, и у каждой пишем, чем она отличается. Неизвестный
     * признак «такой же» не ломает — только слегка отодвигает машину в списке.
     */
    const compare = (other) => {
      const differs = [];
      let distance = 0;
      let exact = true;

      const myGeneration = mine.generation;
      const theirGeneration = generationOf(other);
      if (myGeneration && theirGeneration && !sameTrim(myGeneration, theirGeneration)) {
        distance += 25;
        exact = false;
        differs.push(`поколение ${theirGeneration}`);
      }
      else if (myGeneration && !theirGeneration) {
        distance += 6;
      }

      const theirTrim = trimOf(other);
      // Комплектацию площадка и наш разбор называют по-разному («Carrera S» у Collecting Cars и «50th Anniversary Edition» в названии) —
      // совпадением считаем и то, что одна комплектация названа в заголовке другой машины.
      const trimsAgree = !mine.trim || !theirTrim || sameTrim(mine.trim, theirTrim)
        || normalizeTrim(other.title).includes(normalizeTrim(mine.trim)) || lotTitle.includes(normalizeTrim(theirTrim));
      if (!trimsAgree) {
        distance += 12;
        exact = false;
        differs.push(`комплектация: ${theirTrim}`);
      }
      else if (mine.trim && !theirTrim) {
        distance += 4;
      }

      if (myFlags.has("special") !== hasFlag(other, "special")) {
        distance += 15;
        exact = false;
        differs.push(myFlags.has("special") ? "обычная версия" : "особая версия");
      }
      if (myCondition && conditionOf(other) !== myCondition) {
        distance += 8;
        exact = false;
        differs.push(conditionOf(other) ? CONDITION_LABELS[conditionOf(other)] : "состояние не указано");
      }
      if (lot.bodyStyle && other.bodyStyle && lot.bodyStyle !== other.bodyStyle) {
        distance += 6;
        exact = false;
        differs.push(`кузов: ${other.bodyStyle}`);
      }
      if (lot.transmissionKind && other.transmissionKind && lot.transmissionKind !== other.transmissionKind) {
        distance += 5;
        exact = false;
        differs.push(other.transmissionKind === "manual" ? "механика" : "автомат");
      }
      if (engineLabel(lot) && engineLabel(other) && engineLabel(lot) !== engineLabel(other)) {
        distance += 4;
        exact = false;
        differs.push(`двигатель: ${engineLabel(other)}`);
      }
      if (typeof lot.year === "number" && typeof other.year === "number") {
        const gap = Math.abs(lot.year - other.year);
        distance += gap * 1.5;
        if (gap > 2) {
          exact = false;
          differs.push(`${other.year} г.`);
        }
      }
      if (typeof lot.mileage === "number" && typeof other.mileage === "number") {
        const gap = Math.abs(mileageBand(lot.mileage) - mileageBand(other.mileage));
        distance += gap;
        if (gap >= 2)
          differs.push(`пробег ${Math.round(other.mileage / 1000)} тыс. миль`);
      }
      if (isLowMileage(lot) !== isLowMileage(other))
        distance += 3;
      if (myFlags.has("oneOwner") !== hasFlag(other, "oneOwner"))
        distance += 1;

      return { other, distance, exact, differs };
    };

    const byClosest = (x, y) => x.distance - y.distance || Date.parse(y.other.soldAt) - Date.parse(x.other.soldAt);
    const ranked = pool.map(compare).sort(byClosest);
    const exactList = ranked.filter(item => item.exact);
    const nearList = ranked.filter(item => !item.exact);

    // Достаточно «таких же» — показываем только их; мало — добавляем ближайшие, пока в списке не станет хотя бы 10.
    const shown = exactList.length >= minExact
      ? exactList.slice(0, listSize)
      : [...exactList, ...nearList.slice(0, Math.max(0, Math.min(listSize, 10) - exactList.length))];
    const basis = exactList.length >= minExact ? "exact" : "nearest";
    const statsOver = basis === "exact" ? exactList : shown;

    const prices = statsOver.map(item => item.other.salePrice).sort((x, y) => x - y);
    const at = q => (prices.length ? prices[Math.min(prices.length - 1, Math.floor((prices.length - 1) * q))] : null);

    const criteria = [
      mine.generation ? `поколение ${mine.generation}` : null,
      mine.trim,
      myFlags.has("modified") ? "доработанные" : "серийные",
      myFlags.has("special") ? "особая версия" : "обычная версия",
      myCondition ? CONDITION_LABELS[myCondition] : null,
      lot.bodyStyle,
      lot.transmissionKind ? (lot.transmissionKind === "manual" ? "механика" : "автомат") : null,
      typeof lot.year === "number" ? `${lot.year - 2}–${lot.year + 2} гг.` : null,
    ].filter(Boolean);

    return {
      line: mine.family ? `${lot.make} ${mine.family}` : null,
      criteria,
      basis,
      exactCount: exactList.length,
      count: statsOver.length,
      thin: exactList.length < 3,
      median: at(0.5),
      low: at(0.25),
      high: at(0.75),
      lots: shown.map(item => ({ ...fullLot(item.other), similarity: item.exact ? "exact" : "near", differs: item.differs })),
    };
  }

  /* Все продажи этой же машины (по VIN или номеру шасси), от старых к новым; пусто, если она продавалась один раз. */
  history(id) {
    this.refresh();
    const index = this.resaleOf.get(id);
    if (index === undefined)
      return [];
    return this.resaleGroups[index].map(fullLot);
  }

  /* Уровень уверенности в личности машины для страницы лота (см. identityOf). */
  identity(id) {
    this.refresh();
    const lot = this.byId.get(id);
    if (!lot)
      return null;
    const index = this.resaleOf.get(id);
    return identityOf(lot, index === undefined ? [] : this.resaleGroups[index]);
  }

  lot(id) {
    this.refresh();
    const lot = this.byId.get(id);
    return lot ? fullLot(lot) : null;
  }
}

module.exports = { SoldIndex, fullLot, identityOf, POINT_FIELDS };
