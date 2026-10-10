const { MinskMarketPrices } = require("./minsk-prices");
const { OtomotoSource, PlnRates } = require("./otomoto");
const path = require("path");

/*
 * Цена машины в Польше: медиана объявлений otomoto.pl по тем же правилам
 * подбора (год, пробег, выбросы), что и в Беларуси. Мусорные объявления у
 * поляков называются по-своему: «uszkodzony», «powypadkowy», «na części».
 */
const JUNK_PL = /uszkodz|powypadk|bity|po\s*wypadku|po\s*kolizji|na\s*cz[eę][sś]ci|do\s*remontu|do\s*naprawy|do\s*poprawek|szkoda|niesprawn|bez\s*silnika|wrak|zalan|po\s*gradzie/i;

const createPolandPrices = (options = {}) => new MinskMarketPrices({
  cacheFile: options.cacheFile || path.join(process.cwd(), "data", "market-prices-pl-cache.json"),
  sources: options.sources || [new OtomotoSource({ fx: options.fx || new PlnRates() })],
  priceBasis: "медиана цен объявлений otomoto.pl (брутто, с НДС) исправных аналогов по всей Польше",
  notes: ["Цены с otomoto.pl указаны брутто — как видит их покупатель в Польше."],
  junkPattern: JUNK_PL,
  regionLabel: "Польше",
  ...options,
});

module.exports = { JUNK_PL, createPolandPrices };
