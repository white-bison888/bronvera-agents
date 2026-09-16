/*
 * КОМПЛЕКТАЦИЯ ЛОТА ПРОТИВ ЗАПРОСА
 *
 * bid.cars пишет комплектацию по VIN, и VIN часто не различает версии:
 * «2017 Tesla Model S, 100D/60D/75D/90D...» — это список возможных, а не
 * одна. Copart и вовсе даёт «2018 Tesla MODEL S» без комплектации.
 *
 * Решение Mikita 2026-09-15: лот подходит, если запрошенная комплектация
 * есть среди возможных, — с пометкой «комплектация не подтверждена».
 * Лоты без данных о комплектации в выдачу не идут, но считаются: так
 * видно, что поиск их не потерял, а не смог проверить.
 */

const token = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// «2017 Tesla Model S, 100D/60D/75D/90D...» → ["100d", "60d", "75d", "90d"]
const possibleTrims = (car) => {
  let text = String(car?.trim || "").trim();

  // Начало «2017 Tesla Model S,» повторяет карточку лота; без запятой комплектации нет вовсе.
  if (/^(19|20)\d{2}\s/.test(text))
    text = text.includes(",") ? text.slice(text.indexOf(",") + 1).trim() : "";

  const truncated = Boolean(car?.trimTruncated) || /(\.\.\.|…)$/.test(text);
  const trims = text
    .replace(/(\.\.\.|…)$/, "")
    .split(/[/,|]/)
    .map(part => part.trim())
    .filter(Boolean);

  return { trims, truncated };
};

/*
 * Для показа человеку: обрезанный хвост «Long Ra...» превращаем в «Long»
 * или выбрасываем, если от названия остался огрызок. Сравнение при этом
 * идёт по исходным словам — так «Long Range» находится и в обрезанном.
 */
const trimLabels = (car) => {
  const { trims, truncated } = possibleTrims(car);

  return trims
    .map((name, index) => {
      if (!truncated || index !== trims.length - 1)
        return name;

      const cut = name.includes(" ") ? name.slice(0, name.lastIndexOf(" ")).trim() : "";

      return (cut.includes(" ") || cut.length >= 5) ? cut : "";
    })
    .filter(Boolean);
};

/*
 * confirmed — у лота одна комплектация, и это запрошенная;
 * possible  — запрошенная среди возможных;
 * unknown   — данных нет или список обрезан раньше, чем нашлась запрошенная;
 * mismatch  — полный список, запрошенной в нём нет.
 */
const matchTrim = (car, wanted = []) => {
  const wantedTokens = wanted.map(token).filter(Boolean);
  const { trims, truncated } = possibleTrims(car);

  if (!wantedTokens.length)
    return { status: "confirmed", possible: trimLabels(car) };

  if (!trims.length)
    return { status: "unknown", possible: [] };

  const tokens = trims.map(token);
  // Название «Long Range Dual...» или «Plaid Tri Motor» начинается с запрошенного.
  const found = tokens.some(item => wantedTokens.some(want => item === want || item.startsWith(want)));
  // «Long Range/Perfo...»: обрезан как раз хвост с запрошенной.
  const cut = truncated && tokens.length > 0 && tokens[tokens.length - 1].length >= 3
    && wantedTokens.some(want => want.startsWith(tokens[tokens.length - 1]));

  if (found)
    return { status: tokens.length === 1 ? "confirmed" : "possible", possible: trimLabels(car) };

  if (cut)
    return { status: "possible", possible: trimLabels(car) };

  return { status: truncated ? "unknown" : "mismatch", possible: trimLabels(car) };
};

module.exports = { matchTrim, possibleTrims, trimLabels };
