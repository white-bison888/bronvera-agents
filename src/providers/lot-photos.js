const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { inspectPhoto, MIN_FILE_BYTES } = require("../photos/quality");

/*
 * Снимки лота живут на трёх адресах. Пока торги идут — images.bid.cars.
 * После закрытия лот уходит в архив, и те же кадры отдаются уже с
 * pluto.bid.car (полный размер) и mercury.bid.cars (уменьшенные). Зная
 * только первый адрес, сборщик у архивного лота находил ноль снимков.
 */
const PHOTO_URL_PATTERN
  = /https:\/\/(?:images\.bid\.cars|pluto\.bid\.car|mercury\.bid\.cars)\/[^"'\s\\)]+\.jpg/g;

// От лучшего источника к худшему: превью берём, только если больше нечего.
const PHOTO_HOST_PRIORITY = ["images.bid.cars", "pluto.bid.car", "mercury.bid.cars"];

const isPhotoUrl = url => PHOTO_HOST_PRIORITY.some(host => url.startsWith(`https://${host}/`))
  && url.endsWith(".jpg");

const SEARCH_PAGE_URL = "https://bid.cars/en/search/results?search-type=filters&type=Automobile&status=Active";

const { parseAuctionTiming } = require("./auction-timing");

/*
 * Часть характеристик есть только на странице лота: в карточке каталога
 * нет ни продавца, ни ключа, ни цвета. Отдельный обход ради них заводить
 * нельзя — площадка блокирует уже на втором лоте подряд, поэтому поля
 * снимаются здесь же, за тот самый визит, что нужен для фотографий.
 */
const DETAIL_FIELDS = {
  seller: "Seller",
  saleDocument: "Sale Document",
  loss: "Loss",
  primaryDamage: "Primary damage",
  secondaryDamage: "Secondary damage",
  odometer: "Odometer",
  startCode: "Start code",
  keyPresence: "Key",
  acvErc: "ACV / ERC",
  bodyStyle: "Body Style",
  exteriorColor: "Exterior color",
  transmission: "Transmission",
  fuelType: "Fuel Type",
  location: "Location",
  shippingFrom: "Shipping from",
  estimatedCost: "Estimated cost",
  engine: "Engine",
  cylinders: "Cylinders",
  driveType: "Drive",
  highlights: "Highlights",
};

// Разметка страницы кладёт подпись и значение отдельными строками,
// поэтому берём первую непустую строку после подписи.
const readField = (lines, label) => {
  const index = lines.findIndex(
    line => line === label || line === `${label}:`
  );

  if (index === -1)
    return null;

  for (let i = index + 1; i < Math.min(index + 4, lines.length); i += 1) {
    if (lines[i] && !lines[i].endsWith(":"))
      return lines[i];
  }

  return null;
};

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

    /*
     * Ноль означает «все, что есть на странице». Ограничение в шесть
     * ставили ради экономии на платной модели, но у лота бывает и двадцать
     * снимков, а сорванная крыша может оказаться на семнадцатом.
     * Ограничивать надо разбор, а не сбор: скачанные файлы бесплатны.
     */
    this.maxPhotosPerLot = Number.isFinite(options.maxPhotosPerLot)
      ? options.maxPhotosPerLot
      : 0;

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

  extractPhotoUrls(html, lotNumber = null) {
    const found = [...new Set(html.match(PHOTO_URL_PATTERN) || [])];

    /*
     * На странице архивного лота есть и превью похожих машин с тех же
     * адресов. Свои кадры узнаём по номеру лота в пути: 1-66239746 у архива,
     * 046009893_… у идущих торгов.
     */
    const ownMarks = lotNumber
      ? [String(lotNumber), String(lotNumber).replace(/-/g, "")]
      : null;

    const own = ownMarks
      ? found.filter(url => ownMarks.some(mark => new URL(url).pathname.startsWith(`/${mark}`)))
      : found;

    /*
     * У архивного лота в разметке остаются и старые ссылки images.bid.cars —
     * обычно шесть, и они уже закрыты. Берём адрес, где кадров больше всего,
     * а при равенстве — лучший по качеству.
     */
    const countOn = name => own.filter(url => new URL(url).host === name).length;

    const host = PHOTO_HOST_PRIORITY
      .filter(name => countOn(name) > 0)
      .sort((a, b) => countOn(b) - countOn(a))[0];

    const unique = host
      ? own.filter(url => new URL(url).host === host)
      : [];

    return this.maxPhotosPerLot > 0
      ? unique.slice(0, this.maxPhotosPerLot)
      : unique;
  }

  /*
   * Ссылки на кадры, известные до визита: выдача поиска присылает их
   * списком (img_large). Разбираются тем же правилом, что и разметка
   * страницы, — свои кадры, лучший адрес.
   */
  knownPhotoUrls(lot) {
    const images = Array.isArray(lot?.images) ? lot.images.filter(isPhotoUrl) : [];

    return images.length ? this.extractPhotoUrls(images.join(" "), lot.lotNumber) : [];
  }

  /*
   * Запасной путь, когда страница лота закрыта (403). Страницу поиска
   * bid.cars закрывает редко, а кадры, запрошенные с неё как картинки,
   * отдаются в полном размере (проверено 15.09: 6 из 6). По прямой ссылке
   * те же файлы дают 403.
   */
  async collectFromKnownUrls(page, context, lotNumber, urls, intercepted) {
    try {
      const response = await page.goto(SEARCH_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

      if (!response || !response.ok())
        console.log(`   ${lotNumber}: страница поиска тоже недоступна (${response ? response.status() : "нет ответа"})`);

      await page.waitForTimeout(3000);
    } catch {
      // Пробуем подгрузить кадры с той страницы, что уже открыта.
    }

    return this.loadKnownUrls(page, context, lotNumber, urls, intercepted);
  }

  // Кадры подгружаются картинками с уже открытой страницы bid.cars.
  async loadKnownUrls(page, context, lotNumber, urls, intercepted) {
    // По одному: пачка из двадцати кадров разом похожа на выкачку.
    for (const url of urls) {
      await this.warmMissingImages(page, [url]);
      await page.waitForTimeout(300);
    }

    await page.waitForTimeout(1500);

    return this.savePhotos(context, lotNumber, urls, intercepted);
  }

  /*
   * Кадры кандидатов утреннего отбора без визитов на страницы лотов: одна
   * страница поиска и ссылки из выдачи. Страницы лотов bid.cars закрывает
   * через раз, а очередь ходит на них по лоту в четыре минуты — к торгам
   * фото могли не успеть. Что не скачалось здесь, соберёт очередь.
   */
  async collectFromListing(lots = []) {
    const pending = lots
      .map(lot => ({ lot, urls: this.knownPhotoUrls(lot) }))
      .filter(({ lot, urls }) => urls.length > 0 && this.readPhotoDir(lot.lotNumber).length === 0);

    const result = {};

    if (pending.length === 0)
      return result;

    console.log(`📸 Кадры по ссылкам из выдачи: ${pending.length} лот(ов)`);

    const cache = this.loadCache();
    const { browser, context, page, intercepted } = await this.openBrowser();

    try {
      const response = await page.goto(SEARCH_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

      if (!response || !response.ok()) {
        console.log(`   страница поиска недоступна (${response ? response.status() : "нет ответа"}) — кадры соберёт очередь`);
        return result;
      }

      await page.waitForTimeout(3000);

      for (const { lot, urls } of pending) {
        const key = String(lot.lotNumber);

        intercepted.clear();

        try {
          const files = await this.loadKnownUrls(page, context, key, urls, intercepted);

          result[key] = files;

          if (files.length > 0) {
            cache[key] = { files, sourceUrls: urls, via: "search-page", fetchedAt: new Date().toISOString() };
            this.saveCache(cache);
          }

          console.log(`   ${key}: по ссылкам из выдачи сохранено ${files.length} из ${urls.length}`);
        } catch (error) {
          console.log(`   ${key}: ошибка — ${error.message}`);
        }
      }
    } finally {
      await browser.close();
    }

    return result;
  }

  /*
   * Аукционы закрывают доступ адресам дата-центров: с сервера
   * страницы лотов отдают проверку Cloudflare, которая не проходится.
   * Резидентный прокси подставляет адрес обычного провайдера —
   * без него сбор на сервере невозможен.
   */
  async openBrowser() {
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

      // Резидентный прокси подменяет сертификаты — без этого
      // браузер обрывает соединение на проверке подлинности.
      ignoreHTTPSErrors: Boolean(proxy),
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

      if (!isPhotoUrl(url))
        return;

      if (!response.ok())
        return;

      try {
        intercepted.set(url, await response.body());
      } catch {
        // Тело могло быть уже недоступно — не страшно, докачаем отдельно.
      }
    });

    return { browser, context, page, intercepted };
  }

  async extractLotDetails(page) {
    let text;
    let title = "";

    try {
      text = await page.evaluate(() => document.body.innerText);
      title = await page.evaluate(() => document.title);
    } catch {
      return null;
    }

    const lines = String(text || "")
      .split("\n")
      .map(line => line.trim());

    const details = {};

    for (const [field, label] of Object.entries(DETAIL_FIELDS)) {
      const value = readField(lines, label);

      if (value)
        details[field] = value;
    }

    /*
     * Полная комплектация есть только здесь, в заголовке страницы:
     * "2021 Tesla Model 3, Long Range Dual Motor All-Wheel Drive | VIN | BidCars".
     * В карточке каталога она обрезана площадкой до "Long Range Dual M...",
     * а VIN-декодер NHTSA для Tesla отдаёт пустой Trim.
     */
    const trimMatch = String(title).match(/^[^,|]+,\s*([^|]+?)\s*\|/);

    if (trimMatch)
      details.trim = trimMatch[1].trim();

    const timing = parseAuctionTiming(String(text || ""));

    for (const [field, value] of Object.entries(timing)) {
      if (value !== null && value !== undefined)
        details[field] = value;
    }

    return Object.keys(details).length > 0 ? details : null;
  }

  /*
   * Снимки лота приходят с images.bid.cars и по прямой ссылке отдают 403 —
   * и через context.request, и при навигации: обе выглядят как запрос
   * робота. А те же файлы браузер спокойно загружает, когда просит их как
   * картинки на странице, с нужными заголовками и куками.
   *
   * Поэтому недостающие кадры не докачиваем, а подставляем странице тегом
   * img: ответы поймает тот же перехватчик, что ловит остальные.
   */
  async warmMissingImages(page, urls) {
    if (urls.length === 0)
      return;

    try {
      await page.evaluate(async (list) => {
        await Promise.all(list.map(src => new Promise((done) => {
          const img = new Image();

          img.onload = img.onerror = () => done();
          img.src = src;

          // Держим вне потока документа: страница не должна дёргаться.
          img.style.position = "absolute";
          img.style.left = "-9999px";

          document.body.appendChild(img);
        })));
      }, urls);
    } catch {
      // Не вышло — останется запасной путь со снимком экрана.
    }
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

      // Заглушка «изображение недоступно» приходит с кодом 200 и весит
      // считанные килобайты — на диске от настоящего кадра её отличает
      // только проверка.
      const keepIfUsable = async () => {
        const defect = await inspectPhoto(file);

        if (defect) {
          console.log(`   ${lotNumber}: кадр отброшен — ${defect}`);
          fs.unlinkSync(file);

          return false;
        }

        files.push(file);

        return true;
      };

      const body = intercepted.get(url);

      if (body) {
        fs.writeFileSync(file, body);
        await keepIfUsable();
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
        await keepIfUsable();

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
      .locator('img[src*="images.bid.cars"], img[src*="pluto.bid.car"], img[src*="mercury.bid.cars"]')
      .all();

    const files = [];

    /*
     * На странице десятки изображений, но большинство — миниатюры
     * галереи и превью похожих лотов. Брать первые попавшиеся нельзя:
     * нужны крупные кадры самого автомобиля, поэтому сначала отбираем
     * подходящие по размеру и только потом снимаем.
     */
    for (const image of images) {
      if (files.length >= limit)
        break;

      try {
        await image.scrollIntoViewIfNeeded({ timeout: 5000 });

        const box = await image.boundingBox();

        if (!box || box.width < 300 || box.height < 200)
          continue;

        const file = path.join(lotDir, `shot-${files.length + 1}.jpg`);

        // Пустые кадры, снятые до этой проверки, лежат на диске
        // с прошлых заходов — перезаписываем их, а не принимаем.
        if (fs.existsSync(file) && !(await inspectPhoto(file))) {
          files.push(file);
          continue;
        }

        /*
         * Место в разметке элемент занимает сразу, а пиксели приходят
         * позже. Снимок, сделанный в этом промежутке, — белый лист,
         * поэтому ждём, пока картинка действительно загрузится.
         */
        const painted = await image.evaluate(node => new Promise((resolve) => {
          if (node.complete && node.naturalWidth > 0)
            return resolve(true);

          const finish = () => resolve(node.naturalWidth > 0);

          node.addEventListener("load", finish, { once: true });
          node.addEventListener("error", () => resolve(false), { once: true });

          setTimeout(finish, 8000);
        }));

        if (!painted)
          continue;

        // Браузеру нужен ещё кадр, чтобы вывести загруженную картинку
        // на экран.
        await page.waitForTimeout(250);
        await image.screenshot({ path: file, type: "jpeg", quality: 85 });

        const defect = await inspectPhoto(file);

        // Пустой кадр на диске опаснее отсутствия кадра: он выглядит
        // как фотография и доходит до заключения.
        if (defect) {
          console.log(`   ${lotNumber}: кадр отброшен — ${defect}`);
          fs.unlinkSync(file);
          continue;
        }

        files.push(file);
      } catch {
        // Элемент мог не отрисоваться — пропускаем и берём следующий.
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
      .map(name => path.join(lotDir, name))
      /*
       * Пустой кадр весит пару килобайт. Если его не отсеять здесь,
       * лот считается «уже собранным» и в очередь на пересбор
       * никогда не вернётся.
       */
      .filter((file) => {
        try {
          return fs.statSync(file).size >= MIN_FILE_BYTES;
        } catch {
          return false;
        }
      });
  }

  /*
   * Характеристики, снятые со страниц лотов в этом заходе. Отдельно от
   * файлов, чтобы не менять форму ответа collect() — её читают в нескольких
   * местах, и там ждут список путей к снимкам.
   */
  takeDetails() {
    const collected = this.details || {};

    this.details = {};

    return collected;
  }

  /*
   * refill — зайти на страницу, даже если снимки уже лежат на диске.
   * Нужен лотам, собранным при старом лимите в шесть кадров: уже
   * скачанные файлы не перекачиваются, добавляются только недостающие.
   */
  async collect(lots = [], { refill = false } = {}) {
    this.details = {};

    const cache = this.loadCache();
    const result = {};

    const missing = lots.filter((lot) => {
      const onDisk = this.readPhotoDir(lot.lotNumber);

      if (onDisk.length > 0 && !refill) {
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

    const { browser, context, page, intercepted } = await this.openBrowser();

    try {
      // Прогрев: заходим как обычный посетитель, с главной.
      // Через резидентный прокси страница грузится медленно, поэтому
      // неудача прогрева не должна ронять весь сбор.
      try {
        await page.goto("https://bid.cars/en/", {
          waitUntil: "domcontentloaded",
          timeout: 90000,
        });

        await page.waitForTimeout(2000);
      } catch {
        console.log("   прогрев не удался, идём сразу к лоту");
      }

      for (const lot of missing) {
        const key = String(lot.lotNumber);

        intercepted.clear();

        try {
          const response = await page.goto(lot.url, {
            waitUntil: "domcontentloaded",
            timeout: 90000,
          });

          if (!response || !response.ok()) {
            const status = response ? response.status() : "нет ответа";

            console.log(`   ${key}: страница недоступна (${status})`);

            result[key] = [];

            const known = this.knownPhotoUrls(lot);

            if (known.length > 0) {
              const files = await this.collectFromKnownUrls(page, context, key, known, intercepted);

              result[key] = files;

              if (files.length > 0) {
                cache[key] = { files, sourceUrls: known, via: "search-page", fetchedAt: new Date().toISOString() };
                this.saveCache(cache);
              }

              console.log(`   ${key}: по ссылкам из выдачи сохранено ${files.length} из ${known.length}`);
            }

            // Отказ означает, что нас заметили: ждём заметно дольше.
            await page.waitForTimeout(this.delayMs * 3);
            continue;
          }

          // Галерея подгружается по мере прокрутки.
          await page.mouse.wheel(0, 2500);
          await page.waitForTimeout(5000);

          const urls = this.extractPhotoUrls(await page.content(), key);

          const details = await this.extractLotDetails(page);

          if (details)
            this.details[key] = details;

          // Часть кадров браузер грузит сам, часть — нет; добираем недостающие.
          await this.warmMissingImages(
            page,
            urls.filter(url => !intercepted.has(url))
          );

          await page.waitForTimeout(3000);

          let files = await this.savePhotos(context, key, urls, intercepted);

          // Файлы могут быть закрыты, даже когда страница открылась —
          // тогда снимаем то, что уже видно на экране.
          if (files.length === 0) {
            files = await this.screenshotPhotos(
              page,
              key,
              // Снимки с экрана берём ограниченно: это медленный запасной путь.
              this.maxPhotosPerLot > 0 ? this.maxPhotosPerLot : 12
            );

            if (files.length > 0)
              console.log(`   ${key}: файлы закрыты, снято с экрана`);
          }

          // Живые кадры images.bid.cars закрыты — пробуем полноразмерные из выдачи.
          if (files.length === 0) {
            const known = this.knownPhotoUrls(lot).filter(url => !urls.includes(url));

            if (known.length > 0) {
              files = await this.loadKnownUrls(page, context, key, known, intercepted);
              console.log(`   ${key}: по ссылкам из выдачи сохранено ${files.length} из ${known.length}`);
            }
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
