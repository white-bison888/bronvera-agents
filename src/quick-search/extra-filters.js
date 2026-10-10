const { checkSeller, pickSeller } = require("../providers/lot-requirements");

/*
 * Фильтры, которых нет у самой bid.cars (09.10.2026): продавец, повреждение, тип продажи и окно торгов.
 * Применяются к лотам из реестра после поиска, поэтому поиск просит у реестра лотов с запасом.
 *
 * Лот с неизвестным значением в выбранный фильтр не попадает: «не знаем» не равно «подходит».
 */
const SELLER_MODES = ["insurance"];
const DAMAGE_MODES = ["noImpact", "impact"];
const SALE_TYPES = ["auction", "fastBuy"];

// Удар: где-то на кузове есть повреждение от столкновения.
const IMPACT = /front|rear|side|left|right|roof|all over|undercarriage|rollover|\bend\b/i;
// Повреждение без удара: град, механика, мелкие вмятины, износ, вандализм.
const NO_IMPACT = /hail|mechanical|minor|dent|scratch|normal wear|wear\s*\/?\s*tear|vandal/i;

const damageText = lot => [lot.primaryDamage, lot.secondaryDamage]
  .filter(value => value && !/^-+$/.test(String(value).trim()))
  .join(" ");

const damageKind = (lot) => {
  const text = damageText(lot);

  if (!text)
    return null;

  // Удар важнее: «Normal wear» рядом с «Rear end» — всё равно удар.
  if (IMPACT.test(text))
    return "impact";

  return NO_IMPACT.test(text) ? "noImpact" : null;
};

const hasExtraFilters = filters => Boolean(
  filters.sellerMode || filters.damageMode || filters.saleType || filters.saleWindowDays
);

/*
 * sellerOf(lot) — продавец из карточки реестра и записей истории: у Copart в выдаче «---»,
 * настоящий продавец появляется после захода на страницу лота.
 */
const applyExtraFilters = (lots, filters, { now = Date.now(), sellerOf = lot => lot.seller } = {}) => {
  const dropped = { seller: 0, damage: 0, saleType: 0, window: 0 };

  const kept = lots.filter((lot) => {
    if (filters.sellerMode === "insurance" && !checkSeller(sellerOf(lot)).ok) {
      dropped.seller += 1;
      return false;
    }

    if (filters.damageMode && damageKind(lot) !== filters.damageMode) {
      dropped.damage += 1;
      return false;
    }

    if (filters.saleType) {
      const type = lot.saleType === "fastBuy" ? "fastBuy" : "auction";

      if (type !== filters.saleType) {
        dropped.saleType += 1;
        return false;
      }
    }

    if (filters.saleWindowDays) {
      const sale = Date.parse(lot.saleDate || "");

      if (!Number.isFinite(sale) || sale < now || sale > now + filters.saleWindowDays * 24 * 3600 * 1000) {
        dropped.window += 1;
        return false;
      }
    }

    return true;
  });

  return { lots: kept, dropped };
};

// Продавец лота: известный из любого источника важнее «---» из выдачи.
const sellerFromSources = (lot, historySeller) => pickSeller([lot.seller, historySeller]);

module.exports = {
  DAMAGE_MODES,
  SALE_TYPES,
  SELLER_MODES,
  applyExtraFilters,
  damageKind,
  hasExtraFilters,
  sellerFromSources,
};
