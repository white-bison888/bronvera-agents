/*
 * Марка/модель почти нигде не приходят отдельными полями — только в
 * заголовке лота («1985 BMW 325e Coupe 5-Speed», «1918 Rauch & Lang
 * Model B26 Brougham»). Общее для всех площадок, где так устроено
 * (BaT, RM Sotheby's) — год не всегда первое слово, модель кончается
 * на первом слове про кузов/трансмиссию.
 */

// Многословные марки — иначе наивный разбор возьмёт только первое слово.
const MULTI_WORD_MAKES = [
  "Alfa Romeo", "Aston Martin", "Land Rover", "Mercedes-Benz", "Rolls-Royce",
  "De Tomaso", "Am General", "Rauch & Lang", "Factory Five Racing", "Factory Five",
  "The Little Car Company", "Can-Am", "Can Am", "Austin Healey", "John Deere", "American LaFrance",
  "Sin Cars", "Morgan Motor",
];

// Одна марка пишется по-разному — сводим к одному написанию, иначе статистика по ней рассыпается.
const CANONICAL = new Map([
  ["can am", "Can-Am"], ["can-am", "Can-Am"], ["austin healey", "Austin-Healey"],
  ["citroen", "Citroën"], ["detomaso", "De Tomaso"], ["abarth", "Abarth"], ["am general", "AM General"],
]);

/*
 * Известные марки — по ним находим настоящую марку, когда перед ней в заголовке стоит описание:
 * «2021 Oslo Blue Porsche 911», «383-Powered '32 Ford Roadster». Список из самых частых марок архива.
 */
const KNOWN_SINGLE_MAKES = new Set([
  "porsche", "ford", "chevrolet", "mercedes-benz", "bmw", "ferrari", "toyota", "jaguar", "honda", "volkswagen", "dodge", "jeep",
  "audi", "cadillac", "pontiac", "bentley", "mg", "nissan", "gmc", "triumph", "lexus", "fiat", "mazda", "buick", "lamborghini",
  "maserati", "lincoln", "volvo", "subaru", "lotus", "plymouth", "oldsmobile", "datsun", "mini", "mercedes-amg", "mitsubishi",
  "austin-healey", "international", "chrysler", "lancia", "renault", "mercury", "mclaren", "suzuki", "acura", "packard",
  "studebaker", "shelby", "morgan", "saab", "austin", "peugeot", "willys", "rover", "sunbeam", "holden", "citroen", "citroën",
  "ram", "amc", "alpina", "morris", "hummer", "tvr", "ariel", "caterham", "delorean", "bugatti", "infiniti", "detomaso",
  "norton", "tesla", "hudson", "meyers", "auburn", "desoto", "isuzu", "alpine", "jensen", "nash", "daimler", "opel", "vauxhall",
]);
const KNOWN_MULTI_MAKES = MULTI_WORD_MAKES.map(make => make.toLowerCase());

/* Слова-описания перед маркой: «350-Powered», «27-Years-Owned,», «Fuel-Injected,», «Supercharged». */
const DESCRIPTOR_RE = /^(?:\d[\d.,]*[a-z]*-(?:powered|owned)|(?:19|20)\d{2}\.5|.+-(?:powered|owned|built|modified|equipped)|supercharged|turbocharged|fuel-injected|modified|restored|original|one-owner|restomod|.*-years?-.*|.*-decades?-.*)[,]?$/i;
const COLOR_RE = /^(?:blue|red|green|black|white|silver|gr[ae]y|yellow|orange|brown|gold|bronze|beige|metallic|pearl|ivory|cream|burgundy|maroon|purple|violet|turquoise|teal)[,]?$/i;

/*
 * Год не всегда первое слово — бывает «Modified 1996 Porsche…», «9k-Mile
 * 2008 Porsche…», «383-Powered '32 Ford…». Берём то, что идёт сразу после первого года 19xx/20xx
 * (или «'32»), а не первое слово заголовка. У очень старых лотов год бывает
 * приблизительный — «c. 1900s High-Wheeler» — «s» после цифр и необязательное
 * «c.»/«circa» впереди тоже считаем годом.
 */
const YEAR_RE = /(?:\b(?:c\.\s*|circa\s+)?(?:19|20)\d{2}s?\b|['\u2019]\d{2}\b)\s+(.+)$/i;

const startsWithWord = (text, word) => {
  const lower = text.toLowerCase();
  return lower.startsWith(word) && (lower.length === word.length || /[\s,]/.test(lower[word.length]));
};
const canonicalMake = make => CANONICAL.get(make.toLowerCase()) || make;
const multiWordAt = text => MULTI_WORD_MAKES.find(make => startsWithWord(text, make.toLowerCase()));

/* Марка и всё, что после неё в заголовке (для модели). */
const analyse = (title) => {
  const match = title.match(YEAR_RE);
  const words = (match ? match[1] : title).split(/\s+/).filter(Boolean);
  let start = 0;
  while (start < words.length - 1 && DESCRIPTOR_RE.test(words[start]))
    start += 1;

  const take = (index, text, make) => {
    const used = make.includes(" ") ? make.split(/\s+/).length : 1;
    return { make: canonicalMake(make), after: words.slice(index + (text === null ? 1 : used)).join(" ") };
  };

  const here = words.slice(start).join(" ");
  const multi = multiWordAt(here);
  if (multi)
    return { make: canonicalMake(multi), after: words.slice(start + multi.split(/\s+/).length).join(" ") };

  // Описание перед маркой («Oslo Blue Porsche»): известная марка в первых четырёх словах, а перед ней цвет или описание.
  const firstKnown = KNOWN_SINGLE_MAKES.has((words[start] || "").toLowerCase().replace(/,$/, ""));
  if (!firstKnown) {
    for (let k = 1; k <= 3 && start + k < words.length; k += 1) {
      const text = words.slice(start + k).join(" ");
      const found = multiWordAt(text) || (KNOWN_SINGLE_MAKES.has(words[start + k].toLowerCase().replace(/,$/, "")) ? words[start + k].replace(/,$/, "") : null);
      if (found && words.slice(start, start + k).some(word => COLOR_RE.test(word) || DESCRIPTOR_RE.test(word)))
        return { make: canonicalMake(found), after: words.slice(start + k + (found.includes(" ") ? found.split(/\s+/).length : 1)).join(" ") };
    }
  }

  const first = (words[start] || "").replace(/,$/, "");
  return { make: canonicalMake(first), after: words.slice(start + 1).join(" ") };
};

const guessMake = title => analyse(title).make;

/*
 * Модель — слова после марки до первого слова, которое явно про кузов или
 * трансмиссию, а не про саму модель («Modified 1985 BMW 325e Coupe
 * 5-Speed» → «325e», без «Coupe» и «5-Speed»). Не чипсет шасси — только
 * то, что буквально написано в заголовке.
 */
const MODEL_STOP_WORDS = new Set([
  "coupe", "sedan", "convertible", "wagon", "hatchback", "roadster", "targa",
  "spyder", "spider", "cabriolet", "pickup", "truck", "suv", "van", "hardtop",
  "fastback", "liftback", "shooting", "brake", "estate", "saloon", "manual", "automatic",
  "dual-clutch", "transaxle", "transmission", "gearbox", "awd", "rwd", "fwd",
  "4x4", "4×4", "brougham", "phaeton", "tourer", "limousine",
]);
const SPEED_WORD_RE = /^(one|two|three|four|five|six|seven|eight|nine|ten|\d+)[\s-]*speed$/i;

const guessModel = (title, make) => {
  const analysed = analyse(title);
  // make пришёл снаружи (например, у Collecting Cars марка отдельным полем) — режем по нему, а не по нашему разбору.
  let rest = analysed.after;
  if (make && analysed.make.toLowerCase() !== make.toLowerCase()) {
    const match = title.match(YEAR_RE);
    rest = match ? match[1] : title;
    if (startsWithWord(rest, make.toLowerCase()))
      rest = rest.slice(make.length).trim();
  }

  const words = [];
  for (const word of rest.split(/\s+/)) {
    if (MODEL_STOP_WORDS.has(word.toLowerCase()) || SPEED_WORD_RE.test(word))
      break;
    words.push(word);
  }
  return words.join(" ") || null;
};

module.exports = { guessMake, guessModel, canonicalMake };
