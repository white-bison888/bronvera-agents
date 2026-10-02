/*
 * Дописывание проданных лотов данными со страниц самих лотов (02.10.2026,
 * просьба Mikita: цвет, пробег и комплектация «на всех площадках»). В
 * списках площадок этих полей нет или они обрезаны, а на странице лота —
 * полные перечни. Страниц десятки тысяч, поэтому идём фоном, по одной, с
 * паузой, и записываем результат прямо в архив: отметка pageCheckedAt не
 * даёт трогать лот второй раз, а контрольные точки — потерять сделанное
 * при остановке.
 */

/* Дописать только то, чего у лота ещё нет; факты (conditionFacts) — если пока пусты. */
const applyPatch = (lot, patch) => {
  let changed = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || (Array.isArray(value) && !value.length))
      continue;
    const current = lot[key];
    const empty = current === null || current === undefined || (Array.isArray(current) && !current.length);
    if (empty) {
      lot[key] = value;
      changed += 1;
    }
  }
  return changed;
};

const enrichFromPages = async ({
  lots, // массив объектов архива (изменяются на месте)
  fetchHtml, // (lot) => Promise<string|null>; null — страницы нет (404): больше не пробуем
  parse, // (html, lot) => патч полей
  save, // () => void — записать архив
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  delayMs = 600,
  limit = Infinity,
  checkpointEvery = 200,
  log = () => {},
  label = "лотов",
}) => {
  const todo = lots.filter(lot => !lot.pageCheckedAt).slice(0, limit);
  let done = 0;
  let enriched = 0;
  let failures = 0;

  for (const lot of todo) {
    try {
      const html = await fetchHtml(lot);
      if (html !== null)
        // Строки из разбора — «срезы» огромного HTML страницы (V8 хранит ссылку на всю страницу). Копия через JSON
        // даёт самостоятельные строки: иначе каждый лот удерживал бы в памяти свою страницу в полмегабайта и
        // сервер за часы разбора упёрся бы в память.
        enriched += applyPatch(lot, JSON.parse(JSON.stringify(parse(html, lot))));
      lot.pageCheckedAt = new Date(now()).toISOString();
      failures = 0;
    }
    catch (error) {
      failures += 1;
      log(`BRONVERA Rare: страница ${lot.id}: ${error.message}`);
      if (failures >= 5)
        throw new Error(`слишком много подряд сбоев (${error.message}) — остановился на ${done} из ${todo.length}`);
    }

    done += 1;
    if (done % checkpointEvery === 0) {
      save();
      log(`BRONVERA Rare: страницы ${label}: разобрано ${done}/${todo.length}, дописано полей ${enriched}`);
    }
    await sleep(delayMs);
  }

  save();
  return { checked: done, filled: enriched };
};

module.exports = { applyPatch, enrichFromPages };
