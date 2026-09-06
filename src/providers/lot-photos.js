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

    /*
     * Bid.Cars отдаёт 403 уже со второго-третьего лота подряд, поэтому
     * пауза между страницами длинная и слегка случайная — ровный
     * интервал сам по себе выдаёт автоматизацию.
     */
    this.delayMs = options.delayMs || 5000;
    this.delayJitterMs = options.delayJitterMs || 3000;
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

  /*
   * Сначала берём то, что браузер скачал сам при отрисовке страницы,
   * а недостающее догружаем по одному — из того же контекста, где уже
   * стоят куки Cloudflare. Пачкой качать нельзя: всплеск запросов
   * приводит к 403.
   */
  async savePhotos(context, lotNumber, urls, intercepted) {
    const lotDir = path.join(this.photoDir, String(lotNumber));

    fs.mkdirSync(lotDir, { recursive: true });

    const files = [];

    for (const [index, url] of urls.entries()) {
      const file = path.join(lotDir, `${index + 1}.jpg`);

      if (fs.existsSync(file)) {
        files.push(file);
        continue;
      }

      const body = intercepted.get(url);

      if (body) {
        fs.writeFileSync(file, body);
        files.push(file);
        continue;
      }

      try {
        const response = await context.request.get(url, {
          headers: { referer: "https://bid.cars/" },
          timeout: 20000,
        });

        if (!response.ok())
          continue;

        fs.writeFileSync(file, await response.body());
        files.push(file);

        await new Promise(resolve => setTimeout(resolve, 400));
      } catch {
        // Один пропущенный кадр не мешает оценке остальных.
      }
    }

    return files;
  }

  /*
   * Запасной путь, когда Bid.Cars отдаёт 403 на сами файлы: снимок
   * уже отрисован в браузере, поэтому его можно снять с экрана — это
   * не требует ни одного дополнительного запроса к сайту.
   */
  async screenshotPhotos(page, lotNumber, limit) {
    const lotDir = path.join(this.photoDir, String(lotNumber));

    fs.mkdirSync(lotDir, { recursive: true });

    const images = await page
      .locator('img[src*="images.bid.cars"]')
      .all();

    const files = [];

    for (const [index, image] of images.slice(0, limit).entries()) {
      const file = path.join(lotDir, `shot-${index + 1}.jpg`);

      if (fs.existsSync(file)) {
        files.push(file);
        continue;
      }

      try {
        const box = await image.boundingBox();

        // Иконки и невидимые превью для оценки бесполезны.
        if (!box || box.width < 300 || box.height < 200)
          continue;

        await image.screenshot({ path: file, type: "jpeg", quality: 85 });
        files.push(file);
      } catch {
        // Элемент мог уехать за пределы экрана — пропускаем.
      }
    }

    return files;
  }

  /*
   * Источник истины — файлы на диске, а не запись в кэше: снимки
   * можно положить в папку лота руками, когда Bid.Cars блокирует сбор.
   */
  readPhotoDir(lotNumber) {
    const lotDir = path.join(this.photoDir, String(lotNumber));

    if (!fs.existsSync(lotDir))
      return [];

    return fs
      .readdirSync(lotDir)
      .filter(name => /\.(jpe?g|png|webp)$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(name => path.join(lotDir, name));
  }

  async collect(lots = []) {
    const cache = this.loadCache();
    const result = {};

    const missing = lots.filter((lot) => {
      const onDisk = this.readPhotoDir(lot.lotNumber);

      if (onDisk.length > 0) {
        result[String(lot.lotNumber)] = onDisk;

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

    /*
     * Аукционы закрывают доступ адресам дата-центров: с сервера
     * страницы лотов отдают проверку Cloudflare, которая не проходится.
     * Резидентный прокси подставляет адрес обычного провайдера —
     * без него сбор на сервере невозможен.
     */
    const proxy = process.env.PROXY_SERVER
      ? {
          server: process.env.PROXY_SERVER,
          ...(process.env.PROXY_USERNAME
            ? {
                username: process.env.PROXY_USERNAME,
                password: process.env.PROXY_PASSWORD || "",
              }
            : {}),
        }
      : undefined;

    if (proxy)
      console.log(`   через прокси: ${proxy.server}`);

    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
      ...(proxy ? { proxy } : {}),
    });

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

    // Признак автоматизации, по которому защита узнаёт робота.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();

    // Снимки, которые браузер скачал сам при отрисовке страницы.
    // Так они достаются бесплатно, без повторных запросов к Bid.Cars.
    const intercepted = new Map();

    page.on("response", async (response) => {
      const url = response.url();

      if (!url.includes("images.bid.cars") || !url.endsWith(".jpg"))
        return;

      if (!response.ok())
        return;

      try {
        intercepted.set(url, await response.body());
      } catch {
        // Тело могло быть уже недоступно — не страшно, докачаем отдельно.
      }
    });

    try {
      // Прогрев: заходим как обычный посетитель, с главной.
      // Переход сразу на карточку лота выглядит подозрительно.
      await page.goto("https://bid.cars/pl/", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });

      await page.waitForTimeout(2000);

      for (const lot of missing) {
        const key = String(lot.lotNumber);

        intercepted.clear();

        try {
          const response = await page.goto(lot.url, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });

          if (!response || !response.ok()) {
            const status = response ? response.status() : "нет ответа";

            console.log(`   ${key}: страница недоступна (${status})`);

            result[key] = [];

            // Отказ означает, что нас заметили: ждём заметно дольше.
            await page.waitForTimeout(this.delayMs * 3);
            continue;
          }

          // Галерея подгружается по мере прокрутки.
          await page.mouse.wheel(0, 2500);
          await page.waitForTimeout(2500);

          const urls = this.extractPhotoUrls(await page.content());

          let files = await this.savePhotos(context, key, urls, intercepted);

          // Файлы могут быть закрыты, даже когда страница открылась —
          // тогда снимаем то, что уже видно на экране.
          if (files.length === 0) {
            files = await this.screenshotPhotos(
              page,
              key,
              this.maxPhotosPerLot
            );

            if (files.length > 0)
              console.log(`   ${key}: файлы закрыты, снято с экрана`);
          }

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

        await page.waitForTimeout(
          this.delayMs + Math.random() * this.delayJitterMs
        );
      }
    } finally {
      await browser.close();
    }

    this.saveCache(cache);

    return result;
  }
}

module.exports = LotPhotoCollector;
