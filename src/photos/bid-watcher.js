const { chromium } = require("playwright");
const history = require("../history/store");

/*
 * Ставка на аукционе живёт своей жизнью: в момент анализа она может быть
 * $25, а к закрытию дойти до десяти тысяч. Без этой цифры невозможно
 * ни понять, попали мы в потолок или нет, ни сравнить прогноз с фактом.
 *
 * Следим только за лотами, которые уже проходили анализ, и тем чаще,
 * чем ближе торги — далёкие проверять незачем, это трафик впустую.
 */
const checkInterval = (msToClose) => {
  if (msToClose <= 0)
    return null;

  const hours = msToClose / 3600000;

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

    const lots = this.pickLots();

    if (lots.length === 0)
      return;

    this.running = true;

    try {
      await this.checkLots(lots);
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
      locale: "pl-PL",
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: Boolean(proxy),
    });

    const page = await context.newPage();

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

          const bid = await page.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(
              /(?:Aktualna oferta|Current bid|Aktualna cena)[^\d$]{0,20}\$?\s?([\d,]+)/i
            );

            return match ? Number(match[1].replace(/,/g, "")) : null;
          });

          if (Number.isFinite(bid)) {
            this.saveBid(item.lot, bid, item.msToClose);

            console.log(
              `   ${item.lot}: ставка $${bid} ` +
              `(до закрытия ${Math.round(item.msToClose / 3600000)} ч)`
            );
          }
        } catch (error) {
          console.log(`   ${item.lot}: ${error.message.slice(0, 60)}`);
        }

        await page.waitForTimeout(4000);
      }
    } finally {
      await browser.close();
    }

    this.lastCheck = new Date().toISOString();
  }

  saveBid(lotNumber, bid, msToClose) {
    const cache = this.bidCars.loadCache();
    const now = new Date().toISOString();

    for (const bucket of Object.values(cache.buckets || {})) {
      for (const vehicle of bucket.vehicles || []) {
        if (String(vehicle.lotNumber) !== String(lotNumber))
          continue;

        vehicle.currentBid = bid;
        vehicle.bidCheckedAt = now;

        // История ставок показывает динамику торгов — по ней потом
        // видно, как быстро лот дорожал перед закрытием.
        vehicle.bidHistory = [
          ...(vehicle.bidHistory || []),
          { bid, at: now, hoursLeft: Math.round(msToClose / 3600000) },
        ].slice(-40);
      }
    }

    this.bidCars.saveCache(cache);
  }
}

module.exports = BidWatcher;
