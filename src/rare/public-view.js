/*
 * Что уходит наружу по лотам Rare (10.10.2026, решение Mikita): наружу —
 * только факты и наша обработка. Фотографии и заголовок лота — содержимое
 * площадки, поэтому адрес снимка не отдаём вовсе, а заголовок собираем
 * свой: год, марка, модель, комплектация. Заголовок площадки остаётся во
 * внутренних файлах — по нему разбираются кузов, двигатель и особенности.
 *
 * У активных лотов года отдельным полем нет — берём его из заголовка
 * площадки как факт и отдаём полем year.
 */
const yearFromTitle = (title) => {
  const match = String(title || "").match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
};

const publicTitle = (lot) => {
  const model = lot.model || null;
  const trimInModel = Boolean(lot.trimName) && String(model || "").toLowerCase().includes(String(lot.trimName).toLowerCase());
  const trim = trimInModel ? null : (lot.trimName || null);
  return [lot.year, lot.make, model, trim].filter(Boolean).join(" ") || "Лот";
};

const publicLot = (lot) => {
  if (!lot || typeof lot !== "object")
    return lot;
  const { photoUrl, title, ...rest } = lot;
  const year = lot.year ?? yearFromTitle(title);
  return { ...rest, year, title: publicTitle({ ...lot, year }) };
};

const publicLots = lots => (Array.isArray(lots) ? lots.map(publicLot) : lots);

module.exports = { publicLot, publicLots, publicTitle, yearFromTitle };
