/*
 * ЦЕНЫ ВСЕЙ ЦЕПОЧКИ ПОИСКА — в одном месте (решение Mikita 15.09.2026:
 * стоимость каждого поиска в долларах, всё, что в цепочке, включая сервер).
 *
 * Сменили модель, тариф, провайдера или добавили звено — правим здесь.
 * Звено без цены не превращается в $0: отчёт помечает его «цена неизвестна».
 * Цены в долларах США; месячные счета в евро пересчитываются по курсу ниже.
 */
module.exports = {
  verifiedOn: "2026-09-15",

  eurUsd: {
    rate: 1.1551,
    date: "2026-09-14",
    source: "курс ЕЦБ, api.frankfurter.dev",
  },

  /*
   * ИИ в Dify. Токены и модель каждого шага Dify пишет сам; цена — отсюда.
   * За 1 млн токенов. Кэш подсказок в узлах Dify не включён.
   */
  llm: {
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    models: {
      "claude-opus-5": { provider: "Anthropic", inputPerMTok: 5, outputPerMTok: 25 },
      "claude-opus-4-8": { provider: "Anthropic", inputPerMTok: 5, outputPerMTok: 25 },
      "claude-sonnet-5": { provider: "Anthropic", inputPerMTok: 2, outputPerMTok: 10 },
      "claude-haiku-4-5": { provider: "Anthropic", inputPerMTok: 1, outputPerMTok: 5 },
      "claude-haiku-4-5-20251001": { provider: "Anthropic", inputPerMTok: 1, outputPerMTok: 5 },
    },
  },

  /*
   * Разбор фото. Ключ Gemini работает на бесплатном тарифе (лимиты 15 в
   * минуту и 500 в сутки прописаны в src/yolo-service/vision.py), поэтому
   * платим $0. Цена платного тарифа хранится, чтобы видеть, сколько это
   * стоило бы, и не ошибиться при переходе на платный ключ.
   * Алиас *-latest Google переключает сам — в учёт идёт версия из ответа.
   */
  vision: {
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    tier: "free",
    models: {
      "gemini-3.5-flash-lite": { provider: "Google", inputPerMTok: 0.3, outputPerMTok: 2.5 },
      "gemini-3.1-flash-lite": { provider: "Google", inputPerMTok: 0.25, outputPerMTok: 1.5 },
    },
    // Детектор YOLO работает на нашем сервере: его стоимость — в доле сервера.
  },

  proxy: {
    label: "Прокси DataImpulse (резидентный)",
    usdPerGb: 1,
    source: "https://dataimpulse.com/residential-proxies/ — $1 за 1 ГБ до 50 ГБ",
    // Считаем тела и заголовки запросов браузера; служебный трафик TLS
    // провайдер тоже списывает, поэтому реальный счёт чуть выше.
    note: "≈ по объёму запросов браузера",
  },

  // Бесплатные звенья — в отчёте видно, что они учтены, а не забыты.
  free: [
    { id: "belarus-listings", label: "Цены в Беларуси (auto.kufar.by, ab.onliner.by)" },
    { id: "bidcars", label: "bid.cars (платится только трафик прокси)" },
  ],

  /*
   * Постоянные счета. В стоимость поиска идёт доля по времени его работы,
   * в итог дня — месячная сумма, делённая на дни месяца, в итог месяца — вся.
   */
  fixedMonthly: [
    {
      id: "server",
      label: "Сервер Hetzner CPX22 (Dify, бэкенд, разбор фото)",
      eur: 19.99,
      source: "hetzner.com/cloud: CPX22 €19,49 + IPv4 €0,50; тариф определён по машине (AMD EPYC, 2 vCPU, 4 ГБ, 80 ГБ)",
    },
    {
      id: "vercel",
      label: "Сайт на Vercel (бесплатный тариф)",
      usd: 0,
      source: "Hobby, $0 — со слов Mikita 15.09.2026 («вроде не платил»); в кабинете Vercel не сверено",
    },
  ],
};
