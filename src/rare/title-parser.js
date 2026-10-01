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
  "De Tomaso", "Am General", "Rauch & Lang",
];

/*
 * Год не всегда первое слово — бывает «Modified 1996 Porsche…», «9k-Mile
 * 2008 Porsche…». Берём то, что идёт сразу после первого года 19xx/20xx,
 * а не первое слово заголовка. У очень старых лотов год бывает
 * приблизительный — «c. 1900s High-Wheeler» — «s» после цифр и необязательное
 * «c.»/«circa» впереди тоже считаем годом.
 */
const YEAR_RE = /\b(?:c\.\s*|circa\s+)?(19|20)\d{2}s?\b\s+(.+)$/i;

const guessMake = (title) => {
  const match = title.match(YEAR_RE);
  const rest = match ? match[2] : title;
  const multiWord = MULTI_WORD_MAKES.find(make => rest.startsWith(make));
  if (multiWord)
    return multiWord;
  return rest.split(/\s+/)[0] || "";
};

/*
 * Модель — слова после марки до первого слова, которое явно про кузов или
 * трансмиссию, а не про саму модель («Modified 1985 BMW 325e Coupe
 * 5-Speed» → «325e», без «Coupe» и «5-Speed»). Не чипсет шасси — только
 * то, что буквально написано в заголовке.
 */
const MODEL_STOP_WORDS = new Set([
  "coupe", "sedan", "convertible", "wagon", "hatchback", "roadster", "targa",
  "spyder", "spider", "cabriolet", "pickup", "truck", "suv", "van", "hardtop",
  "fastback", "liftback", "shooting", "brake", "manual", "automatic",
  "dual-clutch", "transaxle", "transmission", "gearbox", "awd", "rwd", "fwd",
  "4x4", "4×4", "brougham", "phaeton", "tourer", "limousine",
]);
const SPEED_WORD_RE = /^(one|two|three|four|five|six|seven|eight|nine|ten|\d+)[\s-]*speed$/i;

const guessModel = (title, make) => {
  const match = title.match(YEAR_RE);
  let rest = match ? match[2] : title;
  if (rest.startsWith(make))
    rest = rest.slice(make.length).trim();

  const words = [];
  for (const word of rest.split(/\s+/)) {
    if (MODEL_STOP_WORDS.has(word.toLowerCase()) || SPEED_WORD_RE.test(word))
      break;
    words.push(word);
  }
  return words.join(" ") || null;
};

module.exports = { guessMake, guessModel };
