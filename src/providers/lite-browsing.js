/*
 * ЛЁГКИЙ ЗАХОД НА СТРАНИЦУ
 *
 * Резидентный прокси считает каждый байт, и 69% трафика съедало слежение
 * за ставками: оно открывало страницу лота целиком, со всеми снимками,
 * хотя ему нужна одна строка «Current Bid». То же и с выдачей поиска:
 * данные приходят готовым JSON, а браузер попутно тянул полсотни
 * превью.
 *
 * Поэтому там, где картинки не нужны, они не загружаются: адреса в
 * разметке остаются на месте (их читает разбор), а байты не тратятся.
 * Сбор фотографий этим не пользуется — там снимки и есть цель.
 */

// Что не нужно ни для текста страницы, ни для перехваченного JSON.
const SKIPPED = ["image", "media", "font"];

const shouldSkip = resourceType => SKIPPED.includes(String(resourceType || ""));

const applyLiteBrowsing = async (context) => {
  await context.route("**/*", (route) => {
    if (shouldSkip(route.request().resourceType()))
      return route.abort();

    return route.continue();
  });

  return context;
};

module.exports = { applyLiteBrowsing, shouldSkip, SKIPPED };
