const queue = require("./queue");
const history = require("../history/store");
const { calculateMaxBid } = require("../economics/max-bid");
const { checkSeller } = require("../providers/lot-requirements");

/*
 * Bid.Cars закрывает доступ уже со второго лота подряд, поэтому сбор
 * растянут во времени: один лот за раз, с большой паузой. Торопиться
 * некуда — снимки нужны не в момент запроса, а к следующему прогону.
 */
class PhotoWorker {
  constructor({ bidCars, photoCollector, photoAssessor, options = {} }) {
    this.bidCars = bidCars;
    this.photoCollector = photoCollector;
    this.photoAssessor = photoAssessor;

    this.intervalMs = options.intervalMs || 4 * 60 * 1000;
    this.timer = null;
    this.running = false;
    this.lastResult = null;
  }

  start() {
    if (this.timer)
      return;

    console.log(
      `🔄 Фоновый сбор фото запущен, интервал ${Math.round(this.intervalMs / 60000)} мин`
    );

    // Первый заход с задержкой: даём серверу подняться целиком.
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    setTimeout(() => this.tick(), 30000);

    /*
     * Слепое пополнение всем реестром выключено: там оседают машины
     * из старых поисков — Model S 2013 года и прочее, что искать
     * никто не собирался. Лоты попадают в очередь по запросу.
     */
    if (process.env.PHOTO_AUTOFILL === "true") {
      this.refillTimer = setInterval(() => this.refillFromRegistry(), 3600000);
      setTimeout(() => this.refillFromRegistry(), 10000);
    }
  }

  /*
   * Чем больше лотов разобрано заранее, тем реже анализ упирается
   * в отсутствие снимков. Поэтому очередь пополняется всем реестром,
   * а не только тем, что запрашивали.
   */
  refillFromRegistry() {
    try {
      const cache = this.bidCars.loadCache();
      const candidates = [];

      for (const bucket of Object.values(cache.buckets || {})) {
        for (const vehicle of bucket.vehicles || []) {
          if (!vehicle.lotNumber || !vehicle.url)
            continue;

          if (this.photoCollector.readPhotoDir(vehicle.lotNumber).length > 0)
            continue;

          candidates.push({ lotNumber: vehicle.lotNumber });
        }
      }

      const added = queue.enqueue(candidates);

      if (added > 0)
        console.log(`📥 В очередь на сбор фото добавлено: ${added}`);
    } catch (error) {
      console.error("Ошибка пополнения очереди:", error.message);
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
  }

  async tick() {
    if (this.running)
      return;

    let item;
    try {
      item = queue.nextPending();
    } catch {
      console.error("Очередь недоступна: обработка приостановлена, данные сохранены");
      return;
    }

    if (!item)
      return;

    this.running = true;

    try {
      await this.processLot(item.lotNumber);
    } catch (error) {
      console.error(`   ${item.lotNumber}: ${error.message}`);

      queue.markFailed(item.lotNumber, error.message);
    } finally {
      this.running = false;
    }
  }

  async processLot(lotNumber) {
    const listing = this.bidCars.findByLotNumber(lotNumber);

    if (!listing || !listing.url) {
      queue.markFailed(lotNumber, "Лота нет в реестре");

      return;
    }

    console.log(`\n📸 Фоновый сбор: ${lotNumber}`);

    const photos = await this.photoCollector.collect([
      { lotNumber, url: listing.url },
    ]);

    const details = (this.photoCollector.takeDetails?.() || {})[String(lotNumber)];

    /*
     * Продавца видно только на странице лота, поэтому требование проверяется
     * здесь, а не при отборе каталога. Чужой продавец — отказ окончательный:
     * убираем лот из очереди, оценку не запускаем.
     */
    const sellerCheck = checkSeller(details?.seller);

    if (sellerCheck.known && !sellerCheck.ok) {
      queue.markDone(lotNumber, 0);

      console.log(`   ${lotNumber}: пропуск — ${sellerCheck.reason}`);

      return;
    }

    if (!sellerCheck.known)
      console.log(`   ${lotNumber}: продавец не прочитан, оцениваем без проверки`);

    if (details)
      this.saveDetails(lotNumber, details);

    const files = photos[String(lotNumber)] || [];

    if (files.length === 0) {
      queue.markFailed(lotNumber, "Снимки недоступны");
      console.log(`   ${lotNumber}: снимки недоступны, попробуем позже`);

      return;
    }

    const assessments = await this.photoAssessor.assess(
      [
        {
          lotNumber,
          make: listing.make,
          model: listing.model,
          year: listing.year,
          primaryDamage: listing.primaryDamage,
          fuelType: listing.fuelType,
        },
      ],
      photos
    );

    const assessment = assessments[0];

    if (assessment?.deferred) {
      const until = queue.markDeferred(lotNumber, assessment.reason);

      console.log(
        `   ${lotNumber}: суточный лимит разбора исчерпан, вернёмся ` +
        `${until ? new Date(until).toLocaleString("ru") : "завтра"}`
      );

      return;
    }

    if (!assessment?.available) {
      queue.markFailed(lotNumber, assessment?.reason || "Оценка фотографий не получена");
      return;
    }

    // Удаляем задачу только после успешной оценки и сохранения истории.
    this.refreshHistory(lotNumber, assessment);
    queue.markDone(lotNumber, files.length);

    console.log(
      `   ${lotNumber}: готово — ${files.length} фото, ` +
      `оценка ${assessment?.severity || "нет"}`
    );

    this.lastResult = {
      lotNumber,
      photos: files.length,
      at: new Date().toISOString(),
    };

  }

  saveDetails(lotNumber, details) {
    try {
      history.setLotDetails(lotNumber, details);
    } catch (error) {
      // Характеристики — дополнение к оценке, ронять из-за них сбор нельзя.
      console.error(`   ${lotNumber}: не удалось сохранить характеристики — ${error.message}`);
    }
  }

  /*
   * Снимки уточняют стоимость ремонта, а значит и предельную ставку.
   * Пересчёт стоит копейки — это формула, а не модель, поэтому делаем
   * его сразу и записываем новой оценкой: в истории будет видно,
   * куда сдвинулся потолок после появления фотографий.
   */
  refreshHistory(lotNumber, assessment) {
    if (!assessment || !assessment.available)
      return;

    const entries = history
      .readAll()
      .filter(entry => String(entry.lotNumber) === String(lotNumber));

    if (entries.length === 0)
      return;

    const latest = entries[entries.length - 1];

    if (latest.repairCostSource === "photo")
      return;

    const listing = this.bidCars.findByLotNumber(lotNumber) || {};

    const seller = listing.seller || entries.map(entry => entry.lotDetails?.seller).filter(Boolean).pop();

    const result = calculateMaxBid({
      ...listing,
      lotNumber,
      ...(seller ? { seller } : {}),
      marketValueUsd: latest.marketValueUsd,
      photoAssessment: assessment,
    });

    history.appendRun([
      {
        lotNumber,
        vin: latest.vin,
        make: latest.make,
        model: latest.model,
        year: latest.year,
        url: latest.url,
        marketValueUsd: latest.marketValueUsd,
        repairCostUsd: result.breakdown?.repairCostUsd ?? null,
        repairCostSource: result.repairCostSource || null,
        damageType: result.damageType || null,
        maxBidUsd: result.maxBidUsd ?? null,
        viable: result.viable === true,
        forecast: result.forecast || null,
        profit: result.profit || null,
        verdictReason: result.reason || null,
        breakdown: result.breakdown || null,
        assumptions: result.assumptions || null,
        notViableReason: result.viable === false ? result.reason : null,
        photoStatus: result.photoStatus || null,
        photosAnalyzed: result.photosAnalyzed ?? null,
        marketReference: latest.marketReference || null,
        // Вердикт, который придержали до появления снимков, теперь
        // подтверждён разбором фотографий и возвращается в карточку.
        decision: result.verdict || (latest.decision === "PENDING_PHOTOS"
          ? latest.decisionHeld || null
          : latest.decision),
        finalScore: latest.finalScore,
        confidence: latest.confidence,
        refinedByPhotos: true,
      },
    ]);

    console.log(
      `   ${lotNumber}: ставка уточнена — ` +
      (result.viable ? `$${result.maxBidUsd}` : "не окупается")
    );
  }
}

module.exports = PhotoWorker;
