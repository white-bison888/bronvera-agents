const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PHOTO_URL_PATTERN = /https:\/\/images\.bid\.cars\/[^"'\s\\)]+\.jpg/g;

/*
 * Фотографии лота не меняются, поэтому кэш здесь вечный: один раз
 * собрали ссылки — больше страницу лота не открываем. Это и экономит
 * запросы к Bid.Cars, и снижает риск блокировки.
 */
class LotPhotoCollector {
  constructor(options = {}) {
    this.cacheFile =
      options.cacheFile ||
      path.join(process.cwd(), "data", "lot-photos-cache.json");

    // Снимки лежат за защитой Cloudflare и по прямой ссылке отдают 403,
    // поэтому качаем их браузером и держим у себя.
    this.photoDir =
      options.photoDir ||
      path.join(process.cwd(), "data", "photos");

    this.maxPhotosPerLot = options.maxPhotosPerLot || 6;

    // Пауза между лотами, чтобы не выглядеть роботом.
    this.delayMs = options.delayMs || 800;
  }

  loadCache() {
    try {
      if (!fs.existsSync(this.cacheFile))
        return {};

      return JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
    } catch (error) {
      console.error("Photo cache read error:", error.message);

      return {};
    }
  }

  saveCache(cache) {
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });

    const tempFile = `${this.cacheFile}.tmp`;

    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tempFile, this.cacheFile);
  }

  extractPhotoUrls(html) {
    const found = html.match(PHOTO_URL_PATTERN) || [];

    return [...new Set(found)].slice(0, this.maxPhotosPerLot);
  }

  async downloadPhotos(context, lotNumber, urls) {
    const lotDir = path.join(this.photoDir, String(lotNumber));

    fs.mkdirSync(lotDir, { recursive: true });

    // Снимки одного лота качаем разом: последовательная загрузка
    // пяти лотов не укладывалась в тайм-аут вызывающего узла.
    const downloads = urls.map(async (url, index) => {
      const file = path.join(lotDir, `${index + 1}.jpg`);

      if (fs.existsSync(file))
        return file;

      // Запрос идёт из контекста браузера, где уже стоят куки Cloudflare,
      // полученные при открытии страницы лота.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await context.request.get(url, {
            headers: { referer: "https://bid.cars/" },
            timeout: 20000,
          });

          if (!response.ok())
            continue;

          fs.writeFileSync(file, await response.body());

          return file;
        } catch {
          // Вторая попытка: одиночные отказы Cloudflare не редкость.
        }
      }

      return null;
    });

    return (await Promise.all(downloads)).filter(Boolean);
  }

  async collect(lots = []) {
    const cache = this.loadCache();
    const result = {};

    const missing = lots.filter((lot) => {
      const cached = cache[String(lot.lotNumber)];

      if (cached && (cached.files || []).every(file => fs.existsSync(file))) {
        result[String(lot.lotNumber)] = cached.files;

        return false;
      }

      return Boolean(lot.url);
    });

    console.log(
      `📸 Фото: из кэша ${lots.length - missing.length}, ` +
      `загрузить ${missing.length}`
    );

    if (missing.length === 0)
      return result;

    const browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 " +
        "(Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 " +
        "Chrome/124 Safari/537.36",

      locale: "pl-PL",

      viewport: { width: 1440, height: 1000 },

      extraHTTPHeaders: {
        "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
      },
    });

    const page = await context.newPage();

    try {
      for (const lot of missing) {
        const key = String(lot.lotNumber);

        try {
          const response = await page.goto(lot.url, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });

          if (!response || !response.ok()) {
            console.log(
              `   ${key}: страница недоступна ` +
              `(${response ? response.status() : "нет ответа"})`
            );

            result[key] = [];
            continue;
          }

          const urls = this.extractPhotoUrls(await page.content());
          const files = await this.downloadPhotos(context, key, urls);

          result[key] = files;

          cache[key] = {
            files,
            sourceUrls: urls,
            fetchedAt: new Date().toISOString(),
          };

          // Пишем сразу: если вызывающая сторона отвалится по тайм-ауту,
          // уже скачанные лоты не придётся собирать заново.
          this.saveCache(cache);

          console.log(
            `   ${key}: найдено ${urls.length}, сохранено ${files.length}`
          );
        } catch (error) {
          console.log(`   ${key}: ошибка — ${error.message}`);

          result[key] = [];
        }

        await page.waitForTimeout(this.delayMs);
      }
    } finally {
      await browser.close();
    }

    this.saveCache(cache);

    return result;
  }
}

module.exports = LotPhotoCollector;
