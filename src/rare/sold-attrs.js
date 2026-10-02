/*
 * Комплектация лота для сравнения «по равным позициям» (02.10.2026, просьба
 * Mikita): цена Porsche 911 Turbo с механикой и цена 911 Carrera с
 * автоматом — разные позиции, их нельзя сводить в одну медиану. Площадки не
 * отдают это отдельными полями, поэтому разбираем то, что написано в
 * заголовке и описании лота. Берём только названное прямо, не угадываем:
 * чего нет в тексте — null.
 *
 *  - bodyStyle — тип кузова (купе, кабриолет, седан…);
 *  - cylinders / engineLayout / displacement / aspiration — двигатель;
 *  - drivetrain — привод, если назван («полный», «задний», «передний»);
 *  - steering — руль слева/справа, если назван.
 */

const BODY_RULES = [
  ["Тарга", /\btarga\b/i],
  ["Кабриолет", /\b(convertible|cabriolet|cabrio|drophead|volante|soft[- ]?top|vert)\b/i],
  ["Родстер", /\b(roadster|spyder|spider|barchetta|speedster)\b/i],
  ["Универсал", /\b(wagon|estate|avant|shooting brake|station wagon|woodie)\b/i],
  ["Пикап", /\b(pickup|pick-up|truck|crew cab|supercrew|supercab|extended cab|regular cab|double cab|ute)\b/i],
  ["Фургон", /\b(van|bus|microbus|camper|motorhome|panel)\b/i],
  ["Внедорожник", /\b(suv|4x4 wagon|sport utility|bronco|wrangler|defender|land cruiser|jimny|blazer|4runner|g-class|g-wagen|range rover)\b/i],
  ["Лифтбек", /\b(liftback|fastback|sportback|gran coupe)\b/i],
  ["Хэтчбек", /\b(hatchback|hatch)\b/i],
  ["Седан", /\b(sedan|saloon|berlina|limousine|limo|town car|brougham|four-door)\b/i],
  ["Купе", /\b(coupe|coupé|hardtop|hard top|two-door|2-door|berlinetta)\b/i],
];

const bodyStyleOf = (...texts) => {
  const text = texts.filter(Boolean).join(" ");
  if (!text)
    return null;
  for (const [label, pattern] of BODY_RULES) {
    if (pattern.test(text))
      return label;
  }
  return null;
};

const WORD_NUMBERS = { three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12, sixteen: 16, two: 2 };

/*
 * Двигатель: «V8», «flat-six», «inline-four», «4.0-liter», «5.7L», «350ci»,
 * «supercharged», «twin-turbocharged». Объём — в литрах (кубические дюймы и
 * см³ пересчитываем).
 */
const engineOf = (...texts) => {
  const text = texts.filter(Boolean).join(" ");
  if (!text)
    return { cylinders: null, engineLayout: null, displacement: null, aspiration: null };

  let cylinders = null;
  let engineLayout = null;

  const horizontal = text.match(/\b(?:H|F)-?(4|6|8)\b/);
  const vee = text.match(/\b([VWvw])\s?-?(2|3|4|5|6|8|10|12|16)\b(?!\s?(?:mm|mph))/);
  const named = text.match(/\b(inline|straight|flat|boxer|horizontally[- ]opposed|rotary)[- ]?(two|three|four|five|six|eight|twelve|2|3|4|5|6|8|12)?\b/i);
  const iLetter = text.match(/\b[Ii]-?(3|4|5|6|8)\b/);
  const cylWords = text.match(/\b(two|three|four|five|six|eight|ten|twelve|sixteen)[- ]cylinder\b/i);

  if (vee) {
    cylinders = Number(vee[2]);
    engineLayout = vee[1].toUpperCase() === "W" ? "W" : "V";
  }
  else if (horizontal) {
    cylinders = Number(horizontal[1]);
    engineLayout = "Оппозитный";
  }
  else if (named) {
    const kind = named[1].toLowerCase();
    if (kind === "rotary") {
      engineLayout = "Роторный";
      cylinders = null;
    }
    else {
      const count = named[2] ? (WORD_NUMBERS[named[2].toLowerCase()] ?? Number(named[2])) : null;
      engineLayout = (kind === "flat" || kind === "boxer" || kind.startsWith("horizontally")) ? "Оппозитный" : "Рядный";
      cylinders = count;
    }
  }
  else if (iLetter) {
    cylinders = Number(iLetter[1]);
    engineLayout = "Рядный";
  }
  else if (cylWords) {
    cylinders = WORD_NUMBERS[cylWords[1].toLowerCase()] ?? null;
  }

  let displacement = null;
  const liters = text.match(/\b(\d{1,2}(?:\.\d{1,2})?)[- ]?(?:liter|litre|l)\b/i);
  const cubicInches = text.match(/\b(\d{2,3})\s?(?:ci|cu\.?\s?in|cubic[- ]inch)\b/i);
  const cc = text.match(/\b(\d{3,4})\s?cc\b/i);
  if (liters && Number(liters[1]) >= 0.5 && Number(liters[1]) <= 9)
    displacement = Number(liters[1]);
  else if (cubicInches && Number(cubicInches[1]) >= 80 && Number(cubicInches[1]) <= 600)
    displacement = Math.round(Number(cubicInches[1]) * 0.0163871 * 10) / 10;
  else if (cc && Number(cc[1]) >= 500 && Number(cc[1]) <= 9000)
    displacement = Math.round(Number(cc[1]) / 100) / 10;

  let aspiration = null;
  if (/\b(twin[- ]turbo|bi[- ]?turbo|turbocharged|turbo)\b/i.test(text) && /\b(supercharged|supercharger|blower)\b/i.test(text))
    aspiration = "Турбо + компрессор";
  else if (/\b(twin[- ]turbo|bi[- ]?turbo|turbocharged|turbo(?:diesel)?|turbos)\b/i.test(text))
    aspiration = "Турбо";
  else if (/\b(supercharged|supercharger|blower|kompressor)\b/i.test(text))
    aspiration = "Компрессор";

  return { cylinders, engineLayout, displacement, aspiration };
};

const drivetrainOf = (...texts) => {
  const text = texts.filter(Boolean).join(" ");
  if (!text)
    return null;
  if (/\b(all[- ]wheel[- ]drive|awd|4matic|quattro|xdrive|four[- ]wheel[- ]drive|4wd|4x4|4×4|4-wheel[- ]drive)\b/i.test(text))
    return "Полный";
  if (/\b(rear[- ]wheel[- ]drive|rwd)\b/i.test(text))
    return "Задний";
  if (/\b(front[- ]wheel[- ]drive|fwd)\b/i.test(text))
    return "Передний";
  return null;
};

const steeringOf = (...texts) => {
  const text = texts.filter(Boolean).join(" ");
  if (/\b(left[- ]hand[- ]drive|lhd)\b/i.test(text))
    return "Левый";
  if (/\b(right[- ]hand[- ]drive|rhd)\b/i.test(text))
    return "Правый";
  return null;
};

/*
 * Всё сразу из заголовка и (если есть) описания. Возвращает только то, что
 * удалось найти; пустые значения не пишем, чтобы не раздувать архив десятков
 * тысяч лотов.
 */
const parseVehicleAttributes = (title, description = "") => {
  const text = `${title || ""}. ${description || ""}`;
  const engine = engineOf(text);
  const result = {
    bodyStyle: bodyStyleOf(title, description),
    cylinders: engine.cylinders,
    engineLayout: engine.engineLayout,
    displacement: engine.displacement,
    aspiration: engine.aspiration,
    drivetrain: drivetrainOf(text),
    steering: steeringOf(text),
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null && value !== undefined));
};

/* Подпись двигателя для фильтра: «V8», «Рядный 6», «Оппозитный 6», «Роторный». */
const engineLabel = ({ cylinders, engineLayout }) => {
  if (engineLayout === "Роторный")
    return "Роторный";
  if (!cylinders)
    return null;
  if (engineLayout === "V" || engineLayout === "W")
    return `${engineLayout}${cylinders}`;
  return `${engineLayout ?? "Рядный"} ${cylinders}`;
};

/* Дописать лоту из архива то, чего у него ещё нет, из заголовка (и описания, если есть) — уже известное не трогаем. */
const fillAttributes = (lot, description = "") => {
  let changed = 0;
  for (const [key, value] of Object.entries(parseVehicleAttributes(lot.title, description))) {
    if (lot[key] === null || lot[key] === undefined) {
      lot[key] = value;
      changed += 1;
    }
  }
  return changed;
};

module.exports = { fillAttributes, engineLabel, bodyStyleOf, drivetrainOf, engineOf, parseVehicleAttributes, steeringOf };
