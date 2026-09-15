/*
 * Информационные плашки bid.cars на странице лота. В выдаче поиска их нет,
 * а они меняют всё: 15.09.2026 Mikita нашёл «Bidding on electric and hybrid
 * vehicles from Hawaii is not possible…» у лота с вердиктом «Покупать» и
 * «Not recommended by BidCars! … most likely a flip» у другого.
 *
 * Лоты с плашками не исключаются (решение Mikita 15.09) — они получают
 * предупреждения, а запрет ставки делает лот «недоступным для ставки».
 */

const { checkSeller } = require("./lot-requirements");

const flat = text => String(text || "").replace(/\s+/g, " ").trim();

const sentence = (text, pattern) => {
  const match = flat(text).match(pattern);

  return match ? match[0].trim() : null;
};

const readLotNotices = (text) => {
  const body = flat(text);

  // «Information! …» — общий заголовок плашек: берём текст до конца предложения.
  const notices = [...body.matchAll(/Information!\s*(.{10,400}?[.!])(?=\s|$)/g)]
    .map(match => match[1].trim());

  const soldBefore = body.match(/sold at another auction\s*([A-Z][a-z]+ \d{1,2}, \d{4})?/i);

  return {
    notices: [...new Set(notices)],
    // Запрет ставки площадкой: снять его нельзя.
    biddingRestricted: sentence(body, /Bidding on [^.]{0,200}?is not possible[^.]*\./i),
    // bid.cars отключил ставки, но разрешает включить их вручную.
    biddingDisabledByBidCars: sentence(body, /Bidding on this vehicle has been disabled[^.]*\./i),
    notRecommended: sentence(body, /Not recommended by BidCars!?[^.]{0,300}\.?/i),
    soldBefore: soldBefore ? (soldBefore[1] || "дата не указана") : null,
  };
};

const NOTICE_FIELDS = ["notices", "biddingRestricted", "biddingDisabledByBidCars", "notRecommended", "soldBefore"];

const isElectricOrHybrid = vehicle => /electric|elektr|hybrid/i.test(String(vehicle.fuelType || ""))
  || /tesla/i.test(String(vehicle.make || ""));

const inHawaii = vehicle => /\(HI\)\s*$|hawaii|honolulu/i.test(String(vehicle.location || ""));

/*
 * Предупреждения лота для расчёта и карточек. Гавайский запрет известен
 * заранее, по месту стоянки и типу машины — поэтому он виден уже в утреннем
 * списке, до визита на страницу лота.
 */
const lotWarnings = (vehicle = {}) => {
  const warnings = [];
  let biddable = true;

  if (vehicle.biddingRestricted) {
    biddable = false;
    warnings.push(`Ставка через bid.cars недоступна: ${vehicle.biddingRestricted}`);
  }
  else if (inHawaii(vehicle) && isElectricOrHybrid(vehicle)) {
    biddable = false;
    warnings.push("Ставка через bid.cars недоступна: электромобили и гибриды с Гавайев перевозчики не везут на материк");
  }

  if (vehicle.notRecommended)
    warnings.push(`bid.cars не рекомендует лот: ${vehicle.notRecommended}`);

  if (vehicle.biddingDisabledByBidCars)
    warnings.push("bid.cars отключил ставки на этот лот (включаются вручную в кабинете)");

  if (vehicle.soldBefore)
    warnings.push(`Лот уже продавался на другом аукционе (${vehicle.soldBefore}) — возможен перекуп`);

  /*
   * Неизвестный продавец не отсекает лот (правило 13.09), но помечается
   * (решение Mikita 15.09). «No information» — площадка сама его не знает;
   * «---» или пусто — страницу лота ещё не удалось прочитать.
   */
  const seller = String(vehicle.seller || "").trim();

  if (!checkSeller(seller).known) {
    warnings.push(/no\s+information/i.test(seller)
      ? "Продавец на bid.cars не указан (No information) — страховой ли он, проверить нельзя"
      : "Продавец ещё не проверен на странице лота — страховой ли он, неизвестно");
  }

  return { warnings, biddable };
};

// Поля плашек из характеристик страницы лота — для передачи в расчёт.
const noticeFields = (details = {}) => Object.fromEntries(
  NOTICE_FIELDS.filter(field => details?.[field]).map(field => [field, details[field]])
);

module.exports = { lotWarnings, noticeFields, readLotNotices };
