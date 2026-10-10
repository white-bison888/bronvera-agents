const { chromium } = require("playwright");
const history = require("../history/store");
const { parseAuctionTiming } = require("../providers/auction-timing");
const { readLotPage } = require("../providers/sale-type");
const { addPoint, readViews } = require("../providers/lot-demand");
const { readTrimFromPage } = require("../providers/lot-trim");
const { meterBrowserContext, withRun } = require("../costs/ledger");
const proxyState = require("../providers/proxy-state");
const { applyLiteBrowsing } = require("../providers/lite-browsing");

/*
 * Ставка на аукционе живёт своей жизнью: в момент анализа она может быть
 * $25, а к закрытию дойти до десяти тысяч. Без этой цифры невозможно
 * ни понять, попали мы в потолок или нет, ни сравнить прогноз с фактом.
 *
 * Следим только за лотами, которые уже проходили анализ, и тем чаще,
 * чем ближе торги — далёкие проверять незачем, это трафик впустую.
 */
// После неудачного захода лот не берём снова это время: очередь достаётся другим лотам.
const RETRY_AFTER_FAILURE_MS = 40 * 60 * 1000;
// Три отказа подряд — площадка нас не пускает (09.10: 466 отказов за двое суток); до следующей попытки ждём подольше.
const BLOCKED_PAUSE_MS = 6 * 3600 * 1000;

const checkInterval = (msToClose) => {
  const hours = msToClose / 3600000;

  /*
   * Дата закрытия сохраняется в момент разбора и устаревает: площадка
   * переносит торги и перевыставляет лоты. Если просто перестать смотреть
   * на прошедшие, лот с устаревшей датой замирает навсегда — поправить её
   * станет некому, и в карточке вечно висит «торги прошли».
   *
   * Поэтому ещё трое суток заглядываем: там либо появится новая дата,
   * либо торги действительно состоялись и лот можно закрывать.
   */
  if (hours <= 0)
    return hours > -72 ? 6 * 3600 * 1000 : null;

  if (hours <= 1)
    return 10 * 60 * 1000;

  if (hours <= 6)
    return 30 * 60 * 1000;

  if (hours <= 24)
    return 2 * 3600 * 1000;

  if (hours <= 72)
    return 6 * 3600 * 1000;

  return null;
};

class BidWatcher {
  constructor({ bidCars, options = {} }) {
    this.bidCars = bidCars;
    this.tickMs = options.tickMs || 10 * 60 * 1000;
    this.timer = null;
    this.running = false;
    this.lastCheck = null;
  }

  start() {
    if (this.timer)
      return;

    console.log("👁  Слежение за ставками запущено");

    this.timer = setInterval(() => this.tick(), this.tickMs);
    setTimeout(() => this.tick(), 90000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /*
   * Кандидат на проверку — лот из истории, торги по которому ещё не
   * прошли и с прошлой проверки истёк срок, положенный его близости
   * к закрытию.
   */
  pickLots() {
    const now = Date.now();
    const seen = new Map();

    for (const entry of history.readAll()) {
      const lot = String(entry.lotNumber);

      if (entry.actual && Number.isFinite(entry.actual.soldPriceUsd))
        continue;

      const listing = this.bidCars.findByLotNumber(lot);

      if (!listing || !listing.saleDate || !listing.url)
        continue;

      const msToClose = new Date(listing.saleDate).getTime() - now;
      const interval = checkInterval(msToClose);

      if (!interval)
        continue;

      const checkedAt = listing.bidCheckedAt
        ? new Date(listing.bidCheckedAt).getTime()
        : 0;

      if (now - checkedAt < interval)
        continue;

      /*
       * Лот, который площадка не открыла (403), не получает отметку «проверен» и
       * иначе занимал бы очередь снова и снова, не пуская остальные. После
       * неудачной попытки даём ему отдохнуть.
       */
      const attemptedAt = listing.bidAttemptAt ? new Date(listing.bidAttemptAt).getTime() : 0;

      if (now - attemptedAt < RETRY_AFTER_FAILURE_MS)
        continue;

      seen.set(lot, { lot, url: listing.url, msToClose });
    }

    return [...seen.values()]
      .sort((a, b) => a.msToClose - b.msToClose)
      .slice(0, 3);
  }

  async tick() {
    if (this.running)
      return;

    // Прокси лежит — ходить некуда: заходы всё равно сорвутся.
    if (proxyState.paused())
      return;

    if (this.blockedUntil && Date.now() < this.blockedUntil)
      return;

    const lots = this.pickLots();

    if (lots.length === 0)
      return;

    this.running = true;

    try {
      // Трафик слежения — отдельная строка в итогах дня, а не расход поиска.
      await withRun("bid-watcher", () => this.checkLots(lots));
    } catch (error) {
      console.error("Слежение за ставками:", error.message);
    } finally {
      this.running = false;
    }
  }

  async checkLots(lots, { pauseMs = 4000 } = {}) {
    // Пауза — число или [мин, макс] в миллисекундах: частые заходы площадка встречает 403.
    const pauseOf = value => (Array.isArray(value)
      ? value[0] + Math.floor(Math.random() * (value[1] - value[0] + 1))
      : value);
    let refused = 0;

    const proxy = process.env.PROXY_SERVER
      ? {
          server: process.env.PROXY_SERVER,
          username: process.env.PROXY_USERNAME,
          password: process.env.PROXY_PASSWORD,
        }
      : undefined;

    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
      ...(proxy ? { proxy } : {}),
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 Chrome/124 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: Boolean(proxy),
    });

    // Нужна одна строка с текущей ставкой — снимки лота не грузим.
    await applyLiteBrowsing(context);

    const page = await context.newPage();

    const meter = meterBrowserContext(context, { source: "слежение за ставками", viaProxy: Boolean(proxy) });

    try {
      for (const item of lots) {
        try {
          const response = await page.goto(item.url, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });

          if (!response || !response.ok()) {
            // Раньше лот пропускался молча — причину тихих сбоев (403 площадки) было не видно.
            console.log(`   ${item.lot}: страница не открылась (${response ? response.status() : "нет ответа"})`);
            this.noteAttempt(item.lot);

            // Три отказа подряд — площадка уже не пускает: дальше заходы только усугубляют блокировку.
            refused += 1;

            if (refused >= 3) {
              console.log("   три отказа подряд — обход остановлен, остальные лоты в следующий раз");
              this.blockedUntil = Date.now() + BLOCKED_PAUSE_MS;
              break;
            }

            // Пауза нужна и после отказа: именно череда быстрых заходов и приводит к 403.
            await page.waitForTimeout(pauseOf(pauseMs));
            continue;
          }

          refused = 0;
          this.blockedUntil = null;

          await page.waitForTimeout(2500);

          const pageText = await page.evaluate(() => document.body.innerText);

          const bidMatch = pageText.match(
            /(?:Aktualna oferta|Current Bid|Aktualna cena)[^\d$]{0,20}\$?\s?([\d,]+)/i
          );

          const bid = bidMatch
            ? Number(bidMatch[1].replace(/,/g, ""))
            : null;

          // Страница уже открыта — дату торгов снимаем тем же заходом.
          const { saleDate } = parseAuctionTiming(pageText);

          /*
           * После закрытия площадка показывает итог: "Final bid $10,600 USD".
           * Рядом та же сумма в евро и злотых, поэтому требуем USD — иначе
           * в историю попадёт другая валюта под видом долларов.
           */
          const finalMatch = pageText.match(
            /Final bid[\s\S]{0,20}?\$\s?([\d,]+)\s*USD/i
          );

          const finalBid = finalMatch
            ? Number(finalMatch[1].replace(/,/g, ""))
            : null;

          // Fast Buy: цена выкупа и признак «Sold by Fast Buy» — с той же страницы.
          const fastBuy = readLotPage(pageText);

          proxyState.noteSuccess();

          this.saveFastBuy(item.lot, fastBuy);

          // Комплектация из заголовка страницы: полный текст площадки, в выдаче он обрезан.
          const trim = readTrimFromPage(pageText);

          if (trim) {
            try {
              history.setLotDetails(item.lot, { trim });
            } catch (error) {
              console.error(`   ${item.lot}: комплектация не сохранена — ${error.message}`);
            }
          }

          // Спрос: просмотры лота — той же страницей, отдельный заход не нужен.
          this.saveViews(item.lot, readViews(pageText));

          if (fastBuy.soldByFastBuy && Number.isFinite(fastBuy.buyNowUsd)) {
            // Выкуплен до торгов: итог — цена выкупа, торгов уже не будет.
            this.saveActual(item.lot, fastBuy.buyNowUsd, { via: "fastBuy" });

            console.log(`   ${item.lot}: выкуплен по Fast Buy за $${fastBuy.buyNowUsd}`);
          }
          else if (Number.isFinite(finalBid)) {
            this.saveActual(item.lot, finalBid, { via: "auction" });

            console.log(`   ${item.lot}: торги завершены, ушёл за $${finalBid}`);
          }
          else if (Number.isFinite(bid) || saleDate) {
            this.saveBid(item.lot, bid, saleDate, item.msToClose);

            console.log(
              `   ${item.lot}: ` +
              (Number.isFinite(bid) ? `ставка $${bid}` : "ставка не прочитана") +
              (saleDate ? `, торги ${new Date(saleDate).toLocaleString("ru")}` : "")
            );
          }
        } catch (error) {
          if (await proxyState.noteFailure(error, { where: "слежение за ставками" }))
            break;

          console.log(`   ${item.lot}: ${error.message.slice(0, 60)}`);
          this.noteAttempt(item.lot);
        }

        await page.waitForTimeout(pauseOf(pauseMs));
      }
    } finally {
      await meter.finish().catch(() => {});
      await browser.close();
    }

    this.lastCheck = new Date().toISOString();
  }

  /*
   * Цена торгов, снятая с площадки. Источник помечаем: вручную вписанная
   * цифра и снятая автоматически — разные по надёжности, и при разборе
   * расхождений это нужно различать.
   */
  saveActual(lotNumber, soldPriceUsd, { via = null } = {}) {
    try {
      history.setActual(lotNumber, {
        soldPriceUsd,
        soldAt: new Date().toISOString(),
        // Чем закончился лот: выкупом по Fast Buy или торгами — прогноз сверяется по-разному.
        via,
        note: via === "fastBuy"
          ? "выкуплен по Fast Buy, снято с bid.cars автоматически"
          : "снято с bid.cars автоматически",
      });
    } catch (error) {
      console.error(`   ${lotNumber}: цена торгов не сохранена — ${error.message}`);
    }
  }

  /*
   * Тип продажи в реестре лотов: по странице видно то, чего нет в выдаче, —
   * выкуплен ли лот уже. Пишем только когда на странице нашлась цена
   * выкупа или признак «Sold by Fast Buy».
   */
  saveFastBuy(lotNumber, { buyNowUsd, soldByFastBuy }) {
    if (!soldByFastBuy && !Number.isFinite(buyNowUsd))
      return;

    const cache = this.bidCars.loadCache();
    const now = new Date().toISOString();

    for (const bucket of Object.values(cache.buckets || {})) {
      for (const vehicle of bucket.vehicles || []) {
        if (String(vehicle.lotNumber) !== String(lotNumber))
          continue;

        if (Number.isFinite(buyNowUsd))
          vehicle.buyNowUsd = buyNowUsd;

        vehicle.saleType = soldByFastBuy ? "fastBuySold" : "fastBuy";

        if (soldByFastBuy && !vehicle.fastBuySoldAt)
          vehicle.fastBuySoldAt = now;
      }
    }

    this.bidCars.saveCache(cache);
  }

  // Отметка о неудачной попытке: по ней pickLots даёт очередь другим лотам.
  noteAttempt(lotNumber) {
    const cache = this.bidCars.loadCache();
    const now = new Date().toISOString();

    for (const bucket of Object.values(cache.buckets || {})) {
      for (const vehicle of bucket.vehicles || []) {
        if (String(vehicle.lotNumber) === String(lotNumber))
          vehicle.bidAttemptAt = now;
      }
    }

    this.bidCars.saveCache(cache);
  }

  /*
   * Просмотры лота: счётчик растёт, поэтому хранится история замеров, а не
   * одно число — по ней считается скорость и уровень спроса.
   */
  saveViews(lotNumber, views) {
    if (!Number.isFinite(views))
      return;

    const cache = this.bidCars.loadCache();
    const now = new Date().toISOString();

    for (const bucket of Object.values(cache.buckets || {})) {
      for (const vehicle of bucket.vehicles || []) {
        if (String(vehicle.lotNumber) !== String(lotNumber))
          continue;

        vehicle.viewsHistory = addPoint(vehicle.viewsHistory, views, now);
      }
    }

    this.bidCars.saveCache(cache);
  }

  saveBid(lotNumber, bid, saleDate, msToClose) {
    const cache = this.bidCars.loadCache();
    const now = new Date().toISOString();

    for (const bucket of Object.values(cache.buckets || {})) {
      for (const vehicle of bucket.vehicles || []) {
        if (String(vehicle.lotNumber) !== String(lotNumber))
          continue;

        if (Number.isFinite(bid)) {
          vehicle.currentBid = bid;

          // История ставок показывает динамику торгов — по ней потом
          // видно, как быстро лот дорожал перед закрытием.
          vehicle.bidHistory = [
            ...(vehicle.bidHistory || []),
            { bid, at: now, hoursLeft: Math.round(msToClose / 3600000) },
          ].slice(-40);
        }

        /*
         * Перенос торгов — обычное дело, и прежняя дата после этого врёт.
         * Пишем новую, а старую сохраняем: по ней видно, что лот
         * переносили, и это само по себе сигнал.
         */
        if (saleDate && saleDate !== vehicle.saleDate) {
          if (vehicle.saleDate) {
            vehicle.saleDateHistory = [
              ...(vehicle.saleDateHistory || []),
              { was: vehicle.saleDate, seenAt: now },
            ].slice(-10);
          }

          vehicle.saleDate = saleDate;
        }

        vehicle.bidCheckedAt = now;
      }
    }

    this.bidCars.saveCache(cache);

    /*
     * Карточка читает дату из истории, а не из реестра лотов. Без этой
     * записи обновление осталось бы невидимым — на экране так и висело бы
     * «торги прошли».
     */
    if (saleDate) {
      try {
        history.setSaleDate(lotNumber, saleDate);
      } catch (error) {
        console.error(`   ${lotNumber}: дата торгов не сохранена — ${error.message}`);
      }
    }
  }
}

module.exports = BidWatcher;
