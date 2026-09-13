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

/*
 * Площадка пишет в это поле либо категорию ("Insurance Company",
 * "Non-insurance Company"), либо имя страховой — Geico, Usaa,
 * Plymouth Rock Assurance. Искать подстроку "insurance" нельзя дважды:
 * она есть внутри "Non-insurance", а у Geico и Usaa её нет вовсе.
 *
 * Поэтому отталкиваемся от единственной явной пометки, которой bid.cars
 * помечает не-страховых продавцов, и всё остальное считаем страховыми.
 */
const NON_INSURANCE = /non-?\s?insurance/i;

/*
 * Продавцы, которые площадка не помечает как Non-insurance, хотя страховыми
 * не являются: прокат и лизинг автопарков. Найдены в реальной выдаче —
 * список пополняется по мере встречи, а не по догадке.
 *
 * Осторожно с похожими названиями: "New Jersey Manufacturing Group" — это
 * NJM Insurance Group, настоящий страховщик, и в список он не входит.
 */
const NOT_INSURERS = [
  /\bhertz\b/i,
  // Пишут и "Wheels Inc", и "Wheels, Inc." — запятая не должна спасать.
  /\bwheels\b[\s,.]*\binc\b/i,
];

// Площадка ставит "---" там, где продавец не указан. Это неизвестность,
// а не подтверждение: без этой проверки такой лот проходил как страховой.
/*
 * Площадка обозначает отсутствие продавца по-разному: "---" в выдаче поиска
 * и "No information" на странице лота. Проверено: у лота с прочерком в
 * каталоге страница показывает именно "No information" — сведений нет
 * нигде, дотянуть их неоткуда.
 *
 * Важно не спутать это с подтверждением: строка непустая, и без явной
 * проверки она проходила как страховая компания.
 */
const UNKNOWN_SELLER = /^-+$|^n\/a$|^unknown$|^no\s+information$/i;

const isInsuranceSeller = value => {
  const seller = String(value || "").trim();

  if (!seller || UNKNOWN_SELLER.test(seller))
    return false;

  if (NOT_INSURERS.some(pattern => pattern.test(seller)))
    return false;

  return !NON_INSURANCE.test(seller);
};

/*
 * Продавца может не быть в данных: страницу лота ещё не обходили.
 * Это не то же самое, что «продавец не тот» — вернуть SKIP здесь значило бы
 * выбросить лот, который ещё никто не проверял.
 */
const checkSeller = (seller) => {
  const value = String(seller || "").trim();

  /*
   * Пусто, прочерк и "No information" — это неизвестность, а не отказ.
   * Разница важна: неподходящего продавца лот получает окончательно и
   * выбывает, а неизвестного — оценивается с пометкой, иначе половина
   * выдачи пропадёт из-за того, чего площадка просто не публикует.
   */
  if (!value || UNKNOWN_SELLER.test(value))
    return { ok: false, known: false, reason: "продавец не указан" };

  if (!isInsuranceSeller(value))
    return {
      ok: false,
      known: true,
      reason: `продавец «${value}», нужна страховая компания`,
    };

  return { ok: true, known: true, reason: null };
};

module.exports = {
  RUN_AND_DRIVE,
  isRunAndDrive,
  isInsuranceSeller,
  checkSeller,
};
