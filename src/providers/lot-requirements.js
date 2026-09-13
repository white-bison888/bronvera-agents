/*
 * Жёсткие требования текущей версии: лот без обоих признаков не рассматриваем.
 *
 *   Start code = Run and Drive
 *   Seller     = Insurance Company
 *
 * Проверяются в разных местах не по прихоти. Start code есть в карточке
 * каталога и отсекает лоты сразу. Seller живёт только на странице лота,
 * а площадка блокирует обход уже со второго лота подряд — поэтому он
 * доезжает лишь после поштучного визита, вместе с фотографиями.
 */

const RUN_AND_DRIVE = "run_and_drive";

const isRunAndDrive = normalizedStartCode =>
  normalizedStartCode === RUN_AND_DRIVE;

const isInsuranceSeller = value =>
  /insurance|ubezpieczenio|страхов/i.test(String(value || ""));

/*
 * Продавца может не быть в данных: страницу лота ещё не обходили.
 * Это не то же самое, что «продавец не тот» — вернуть SKIP здесь значило бы
 * выбросить лот, который ещё никто не проверял.
 */
const checkSeller = (seller) => {
  if (!seller)
    return { ok: false, known: false, reason: "продавец ещё не прочитан" };

  if (!isInsuranceSeller(seller))
    return {
      ok: false,
      known: true,
      reason: `продавец «${seller}», нужна страховая компания`,
    };

  return { ok: true, known: true, reason: null };
};

module.exports = {
  RUN_AND_DRIVE,
  isRunAndDrive,
  isInsuranceSeller,
  checkSeller,
};
