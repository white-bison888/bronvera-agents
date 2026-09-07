/*
 * Bid.Cars отдаёт повреждения по-польски и часто двумя полями:
 * "Kolizja | Przód" и отдельно вторичное. В интерфейсе это выглядело
 * как невнятный обрывок, поэтому приводим к понятному виду.
 */
const DAMAGE_TERMS = [
  [/przód|przednia|front/i, "перед"],
  [/tył|tyl\b|tylna|rear/i, "зад"],
  [/lewa\s*strona|lewy|left/i, "левый борт"],
  [/prawa\s*strona|prawy|right/i, "правый борт"],
  [/dach|roof/i, "крыша"],
  [/podwozie|undercarriage/i, "днище"],
  [/wszędzie|dookoła|all\s*over/i, "по кругу"],
  [/zalanie|powód|water|flood/i, "затопление"],
  [/grad|hail/i, "град"],
  [/pożar|fire|burn/i, "пожар"],
  [/rysy|zarysowania|scratch|vandal/i, "царапины"],
  [/mechanic|silnik|engine/i, "механика"],
  [/kolizja|collision/i, "удар"],
  [/normalne\s*zużycie|wear/i, "износ"],
  [/brak\s*informacji|unknown/i, "не указано"],
];

/*
 * Строка вида "Kolizja | Przód" разбирается на части, каждая переводится
 * отдельно: так сохраняются все упомянутые зоны, а не только первая.
 */
const describeDamage = (primary, secondary) => {
  const seen = new Set();
  const parts = [];

  for (const raw of [primary, secondary]) {
    if (!raw)
      continue;

    for (const chunk of String(raw).split(/[|,/]+/)) {
      const text = chunk.trim();

      if (!text)
        continue;

      const hit = DAMAGE_TERMS.find(([pattern]) => pattern.test(text));
      const label = hit ? hit[1] : text.toLowerCase();

      if (label === "не указано" || seen.has(label))
        continue;

      seen.add(label);
      parts.push(label);
    }
  }

  return parts.length ? parts.join(", ") : null;
};

module.exports = { describeDamage };
