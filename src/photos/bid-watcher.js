const { chromium } = require("playwright");
const history = require("../history/store");
const { parseAuctionTiming } = require("../providers/auction-timing");
const { meterBrowserContext, withRun } = require("../costs/ledger");
const proxyState = require("../providers/proxy-state");

/*
 * Ставка на аукционе живёт своей жизнью: в момент анализа она может быть
 * $25, а к закрытию дойти до десяти тысяч. Без этой цифры невозможно
 * ни понять, попали мы в потолок или нет, ни сравнить прогноз с фактом.
 *
 * Следим только за лотами, которые уже проходили анализ, и тем чаще,
 * чем ближе торги — далёкие проверять незачем, это трафик впустую.
 */
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

  async checkLots(lots) {
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

    const page = await context.newPage();

    const meter = meterBrowserContext(context, { source: "слежение за ставками", viaProxy: Boolean(proxy) });

    try {
      for (const item of lots) {
        try {
          const response = await page.goto(item.url, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });

          if (!response || !response.ok())
            continue;

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

          proxyState.noteSuccess();

          if (Number.isFinite(finalBid)) {
            this.saveActual(item.lot, finalBid);

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
        }

        await page.waitForTimeout(4000);
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
  saveActual(lotNumber, soldPriceUsd) {
    try {
      history.setActual(lotNumber, {
        soldPriceUsd,
        soldAt: new Date().toISOString(),
        note: "снято с bid.cars автоматически",
      });
    } catch (error) {
      console.error(`   ${lotNumber}: цена торгов не сохранена — ${error.message}`);
    }
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
