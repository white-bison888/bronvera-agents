const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { chromium } = require("playwright");
const { parseAuctionTiming } = require("./auction-timing");
const { isRunAndDrive, checkSeller } = require("./lot-requirements");

class BidCarsRateLimitError extends Error {
  constructor(message, retryAfterSeconds = null) {
    super(message);
    this.name = "BidCarsRateLimitError";
    this.status = 429;
    this.code = "RATE_LIMIT";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class BidCarsSourceError extends Error {
  constructor(message, status = null, code = "SOURCE_ERROR") {
    super(message);
    this.name = "BidCarsSourceError";
    this.status = status;
    this.code = code;
  }
}

class BidCarsProvider {
  constructor(options = {}) {
    this.cacheFile =
      options.cacheFile ||
      path.join(process.cwd(), "data", "bidcars-cache.json");

    // Каталог (первая страница конкретного source-scope) обновляем
    // не чаще одного раза в 2 часа.
    this.minRefreshMs =
      Number(options.minRefreshMs) || 2 * 60 * 60 * 1000;

    // После обычной ошибки источника ждём 1 час.
    this.sourceErrorCooldownMs =
      Number(options.sourceErrorCooldownMs) || 60 * 60 * 1000;

    // Более длинный backoff для rate limit / блокировок.
    this.backoffScheduleMs = [
      4 * 60 * 60 * 1000,
      8 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000,
    ];

    // Абсолютный предел глубины каталога за один source-scope.
    // Фактически запрос обычно останавливается раньше, когда набран
    // достаточный пул кандидатов.
    this.maxSafePages =
      Number.isInteger(Number(options.maxSafePages)) &&
      Number(options.maxSafePages) > 0
        ? Number(options.maxSafePages)
        : 10;

    // Сколько НОВЫХ страниц разрешено добрать за один пользовательский
    // поиск, если локального реестра недостаточно.
    this.defaultScanBudgetPages =
      Number.isInteger(Number(options.defaultScanBudgetPages)) &&
      Number(options.defaultScanBudgetPages) > 0
        ? Number(options.defaultScanBudgetPages)
        : 5;

    // Сколько подходящих автомобилей желательно иметь до SELECTOR.
    this.defaultTargetPoolSize =
      Number.isInteger(Number(options.targetPoolSize)) &&
      Number(options.targetPoolSize) > 0
        ? Number(options.targetPoolSize)
        : 20;

    this.queryHistoryLimit =
      Number.isInteger(Number(options.queryHistoryLimit)) &&
      Number(options.queryHistoryLimit) > 0
        ? Number(options.queryHistoryLimit)
        : 100;
  }

  // ============================================================
  // ОСНОВНОЙ ПОИСК
  // ============================================================

  async searchCars(options = {}) {
    const filters = this.normalizeFilters(options);

    const maxResults =
      this.toPositiveInt(options.maxResults, 20);

    // maxPages из LLM больше не может случайно ограничить поиск одной
    // страницей. Это лишь подсказка бюджета, а backend гарантирует
    // минимальный адаптивный бюджет.
    const requestedScanBudget =
      this.toPositiveInt(
        options.maxPages,
        this.defaultScanBudgetPages
      );

    const scanBudgetPages =
      Math.min(
        this.maxSafePages,
        Math.max(
          this.defaultScanBudgetPages,
          requestedScanBudget
        )
      );

    const targetPoolSize =
      Math.max(
        maxResults,
        this.toPositiveInt(
          options.targetPoolSize,
          this.defaultTargetPoolSize
        )
      );

    const bucketKey =
      this.getBucketKey(filters);

    const cache =
      this.loadCache();

    const bucket =
      this.getBucket(cache, bucketKey);

    const now =
      Date.now();

    const lastSuccess =
      bucket.lastSuccessfulUpdateAt
        ? new Date(
            bucket.lastSuccessfulUpdateAt
          ).getTime()
        : null;

    const fresh =
      Boolean(lastSuccess) &&
      now - lastSuccess <
        this.minRefreshMs;

    const nextAllowed =
      bucket.nextAllowedAt
        ? new Date(
            bucket.nextAllowedAt
          ).getTime()
        : 0;

    // nextAllowedAt после обычного успешного refresh используется как
    // информационная TTL-метка. Блокируем source только после реальной
    // ошибки / rate limit / partial 403-429.
    const sourceBlocked =
      now < nextAllowed &&
      (
        (bucket.failureCount || 0) > 0 ||
        [403, 429].includes(
          bucket.partialHttpStatus
        )
      );

    const evaluateLocal =
      () => {
        const pool =
          this.filterAndRank(
            bucket.vehicles,
            filters,
            targetPoolSize
          );

        const listings =
          pool.slice(
            0,
            maxResults
          );

        const coverage =
          this.getCoverageState(
            bucket,
            pool.length,
            targetPoolSize
          );

        return {
          pool,
          listings,
          coverage,
        };
      };

    let local =
      evaluateLocal();

    console.log("\n========================================");
    console.log("🚗 BRONVERA / BID.CARS SEARCH");
    console.log("========================================");
    console.log("Scope:", bucketKey);
    console.log("Filters:", filters);
    console.log("Registry vehicles:", bucket.vehicles.length);
    console.log("Local matches:", local.pool.length);
    console.log(
      "Coverage:",
      local.coverage
    );

    // ----------------------------------------------------------
    // 1. СВЕЖИЙ ЛОКАЛЬНЫЙ РЕЕСТР ДОСТАТОЧЕН
    // ----------------------------------------------------------

    if (
      fresh &&
      (
        local.coverage.status ===
          "sufficient" ||
        local.coverage.complete
      )
    ) {
      console.log(
        "🟢 Достаточно свежих данных в локальном реестре. Bid.Cars не запрашиваем."
      );

      this.recordQuery(
        bucket,
        filters,
        local.coverage
      );

      cache.version = 3;
      cache.buckets[bucketKey] =
        bucket;

      this.saveCache(cache);

      return this.makeResult(
        local.listings,
        filters,
        bucket,
        bucketKey,
        "fresh",
        local.coverage.status ===
          "sufficient"
          ? "cache_sufficient"
          : "cache_complete",
        local.coverage
      );
    }

    // ----------------------------------------------------------
    // 2. SOURCE В BACKOFF — НИЧЕГО НЕ ЛОМАЕМ, ВОЗВРАЩАЕМ CACHE
    // ----------------------------------------------------------

    if (sourceBlocked) {
      console.log(
        `🟡 Bid.Cars временно не опрашиваем до ${bucket.nextAllowedAt}`
      );

      this.recordQuery(
        bucket,
        filters,
        local.coverage
      );

      cache.version = 3;
      cache.buckets[bucketKey] =
        bucket;

      this.saveCache(cache);

      return this.makeResult(
        local.listings,
        filters,
        bucket,
        bucketKey,
        bucket.vehicles.length
          ? "cached"
          : "unavailable",
        bucket.lastHttpStatus ===
          429 ||
        bucket.partialHttpStatus ===
          429
          ? "rate_limited"
          : "cooldown",
        local.coverage
      );
    }

    // ----------------------------------------------------------
    // 3. ЕСЛИ PAGE 1 УСТАРЕЛА — ОБНОВЛЯЕМ ТОЛЬКО ЕЁ
    // ----------------------------------------------------------

    try {
      if (!fresh) {
        console.log(
          "🔄 Обновляем первую страницу source-scope."
        );

        // Полная coverage стареет: каталог мог измениться.
        bucket.catalogExhausted =
          false;
        bucket.coverageCompletedAt =
          null;

        const firstPageRefresh =
          await this.refreshSource({
            bucketKey,
            startPage: 1,
            pageLimit: 1,
            filters,
            targetMatches: null,
            existingVehicles:
              bucket.vehicles,
          });

        const updatedAt =
          new Date();

        this.applySuccessfulRefresh(
          bucket,
          firstPageRefresh,
          updatedAt,
          {
            isCatalogHeadRefresh:
              true,
          }
        );

        cache.version = 3;
        cache.buckets[bucketKey] =
          bucket;

        this.saveCache(cache);

        local =
          evaluateLocal();

        if (
          local.coverage.status ===
            "sufficient" ||
          local.coverage.complete
        ) {
          this.recordQuery(
            bucket,
            filters,
            local.coverage
          );

          cache.buckets[bucketKey] =
            bucket;

          this.saveCache(cache);

          return this.makeResult(
            local.listings,
            filters,
            bucket,
            bucketKey,
            "fresh",
            local.coverage.status ===
              "sufficient"
              ? "updated_sufficient"
              : "updated_complete",
            local.coverage
          );
        }
      }

      // --------------------------------------------------------
      // 4. ЛОКАЛЬНОГО ПОКРЫТИЯ НЕДОСТАТОЧНО — ДОБИРАЕМ ТОЛЬКО
      //    ЕЩЁ НЕ ПРОСМОТРЕННЫЕ СТРАНИЦЫ
      // --------------------------------------------------------

      if (
        !bucket.catalogExhausted
      ) {
        const startPage =
          Math.max(
            1,
            (bucket.highestPageFetched ||
              0) + 1
          );

        if (
          startPage <=
          this.maxSafePages
        ) {
          const pageLimit =
            Math.min(
              scanBudgetPages,
              this.maxSafePages -
                startPage +
                1
            );

          console.log(
            `🔎 Расширяем покрытие: страницы ${startPage}..${startPage + pageLimit - 1}`
          );

          const expansion =
            await this.refreshSource({
              bucketKey,
              startPage,
              pageLimit,
              filters,
              targetMatches:
                targetPoolSize,
              existingVehicles:
                bucket.vehicles,
            });

          const expandedAt =
            new Date();

          this.applySuccessfulRefresh(
            bucket,
            expansion,
            expandedAt,
            {
              isCatalogHeadRefresh:
                false,
            }
          );

          bucket.lastExpansionAt =
            expandedAt.toISOString();

          cache.version = 3;
          cache.buckets[bucketKey] =
            bucket;

          this.saveCache(cache);

          local =
            evaluateLocal();
        }
      }

      // --------------------------------------------------------
      // 5. ФИНАЛЬНЫЙ РЕЗУЛЬТАТ ЭТОГО ПОИСКА
      // --------------------------------------------------------

      this.recordQuery(
        bucket,
        filters,
        local.coverage
      );

      cache.version = 3;
      cache.buckets[bucketKey] =
        bucket;

      this.saveCache(cache);

      const sourceUpdateStatus =
        local.coverage.status ===
          "sufficient"
          ? "expanded_sufficient"
          : local.coverage.complete
          ? "expanded_complete"
          : local.coverage.status ===
            "limit_reached"
          ? "coverage_limit"
          : "expanded_partial";

      return this.makeResult(
        local.listings,
        filters,
        bucket,
        bucketKey,
        bucket.vehicles.length
          ? "fresh"
          : "empty",
        sourceUpdateStatus,
        local.coverage
      );
    } catch (error) {
      const failedAt =
        new Date();

      this.applySourceError(
        bucket,
        error,
        failedAt
      );

      cache.version = 3;
      cache.buckets[bucketKey] =
        bucket;

      this.saveCache(cache);

      local =
        evaluateLocal();

      this.recordQuery(
        bucket,
        filters,
        local.coverage
      );

      cache.buckets[bucketKey] =
        bucket;

      this.saveCache(cache);

      return this.makeResult(
        local.listings,
        filters,
        bucket,
        bucketKey,
        bucket.vehicles.length
          ? "cached"
          : "unavailable",
        bucket.lastHttpStatus ===
          429
          ? "rate_limited"
          : "source_error",
        local.coverage
      );
    }
  }

  applySuccessfulRefresh(
    bucket,
    refresh,
    updatedAt,
    options = {}
  ) {
    const timestamp =
      updatedAt.toISOString();

    bucket.vehicles =
      this.mergeVehicles(
        bucket.vehicles,
        refresh.listings,
        timestamp
      );

    bucket.lastAttemptAt =
      timestamp;

    if (
      options.isCatalogHeadRefresh
    ) {
      bucket.lastSuccessfulUpdateAt =
        timestamp;

      bucket.nextAllowedAt =
        new Date(
          updatedAt.getTime() +
            this.minRefreshMs
        ).toISOString();
    }

    bucket.failureCount = 0;

    bucket.lastHttpStatus =
      refresh.httpStatus ||
      200;

    bucket.lastError = null;
    bucket.lastErrorCode = null;
    bucket.lastRetryAfterSeconds =
      null;

    bucket.lastSourceUrl =
      refresh.lastSourceUrl ||
      null;

    bucket.lastRunPagesFetched =
      refresh.pagesFetched || 0;

    bucket.pagesFetched =
      Math.max(
        bucket.pagesFetched || 0,
        refresh.lastPageFetched ||
          0
      );

    bucket.highestPageFetched =
      Math.max(
        bucket.highestPageFetched ||
          0,
        refresh.lastPageFetched ||
          0
      );

    bucket.partialRefresh =
      Boolean(
        refresh.partialRefresh
      );

    bucket.partialHttpStatus =
      refresh.partialHttpStatus ??
      null;

    bucket.lastStopReason =
      refresh.stopReason ||
      null;

    if (
      refresh.catalogExhausted
    ) {
      bucket.catalogExhausted =
        true;

      bucket.coverageCompletedAt =
        timestamp;
    }

    if (
      refresh.partialRefresh &&
      [403, 429].includes(
        refresh.partialHttpStatus
      )
    ) {
      bucket.nextAllowedAt =
        new Date(
          updatedAt.getTime() +
            this.backoffScheduleMs[0]
        ).toISOString();
    }
  }

  applySourceError(
    bucket,
    error,
    failedAt
  ) {
    bucket.lastAttemptAt =
      failedAt.toISOString();

    bucket.failureCount =
      (bucket.failureCount || 0) +
      1;

    bucket.lastError =
      error.message;

    bucket.lastErrorCode =
      error.code || null;

    if (error.status === 429) {
      bucket.lastHttpStatus = 429;

      bucket.lastRetryAfterSeconds =
        error.retryAfterSeconds ??
        null;

      bucket.nextAllowedAt =
        new Date(
          failedAt.getTime() +
            this.resolveRetryAfterMs(
              error.retryAfterSeconds,
              bucket.failureCount
            )
        ).toISOString();

      console.log(
        "🔴 Bid.Cars: HTTP 429"
      );
    } else {
      bucket.lastHttpStatus =
        error.status || null;

      bucket.lastRetryAfterSeconds =
        null;

      bucket.nextAllowedAt =
        new Date(
          failedAt.getTime() +
            this.sourceErrorCooldownMs
        ).toISOString();

      console.log(
        "🟠 Ошибка источника:",
        error.message
      );
    }

    console.log(
      "Следующая попытка:",
      bucket.nextAllowedAt
    );
  }

  getCoverageState(
    bucket,
    matchCount,
    targetPoolSize
  ) {
    const highestPageFetched =
      bucket.highestPageFetched ||
      bucket.pagesFetched ||
      0;

    if (
      matchCount >=
      targetPoolSize
    ) {
      return {
        status: "sufficient",

        complete:
          Boolean(
            bucket.catalogExhausted
          ),

        matchCount,

        targetPoolSize,

        highestPageFetched,

        maxSafePages:
          this.maxSafePages,
      };
    }

    if (
      bucket.catalogExhausted
    ) {
      return {
        status: "complete",

        complete: true,

        matchCount,

        targetPoolSize,

        highestPageFetched,

        maxSafePages:
          this.maxSafePages,
      };
    }

    if (
      highestPageFetched >=
      this.maxSafePages
    ) {
      return {
        status:
          "limit_reached",

        complete: false,

        matchCount,

        targetPoolSize,

        highestPageFetched,

        maxSafePages:
          this.maxSafePages,
      };
    }

    return {
      status: "partial",

      complete: false,

      matchCount,

      targetPoolSize,

      highestPageFetched,

      maxSafePages:
        this.maxSafePages,
    };
  }

  recordQuery(
    bucket,
    filters,
    coverage
  ) {
    const signature =
      this.querySignature(
        filters
      );

    if (!bucket.queryHistory) {
      bucket.queryHistory = {};
    }

    bucket.queryHistory[
      signature
    ] = {
      filters,

      lastQueriedAt:
        new Date().toISOString(),

      matchCount:
        coverage.matchCount,

      coverageStatus:
        coverage.status,

      coverageComplete:
        coverage.complete,

      highestPageFetched:
        coverage.highestPageFetched,
    };

    const entries =
      Object.entries(
        bucket.queryHistory
      )
        .sort(
          (a, b) =>
            new Date(
              b[1].lastQueriedAt
            ).getTime() -
            new Date(
              a[1].lastQueriedAt
            ).getTime()
        )
        .slice(
          0,
          this.queryHistoryLimit
        );

    bucket.queryHistory =
      Object.fromEntries(
        entries
      );
  }

  querySignature(filters) {
    const stable = {
      ...filters,

      models:
        [...filters.models].sort(),

      fuelTypes:
        [...filters.fuelTypes].sort(),

      bodyStyles:
        [...filters.bodyStyles].sort(),

      driveTypes:
        [...filters.driveTypes].sort(),

      transmissions:
        [...filters.transmissions].sort(),

      startCodes:
        [...filters.startCodes].sort(),

      auctionTypes:
        [...filters.auctionTypes].sort(),
    };

    return JSON.stringify(stable);
  }

  // ============================================================
  // СОВМЕСТИМОСТЬ СО СТАРЫМ TESLA SEARCH
  // ============================================================

  async searchTesla(options = {}) {
    const result = await this.searchCars({
      make: "Tesla",
      ...options,
    });

    return result.listings;
  }

  // ============================================================
  // ВЫБОР КАТАЛОГА
  // ============================================================

  getBucketKey(filters) {
    // Bucket отражает SOURCE-SCOPE, а не пользовательский фильтр.
    // Если пользователь ищет Tesla, используем каталог Tesla независимо
    // от того, указал ли LLM fuelTypes=["electric"].
    if (filters.make) {
      return `make:${this.sourceSlug(
        filters.make
      )}`;
    }

    return "all";
  }

  /*
   * Каталог /automobile/<марка>/page/N умеет фильтровать только по марке
   * и модели, поэтому всё прочее отсеивалось уже у нас: из 343 просмотренных
   * лотов оставалось 24. Поиск с параметрами задаёт те же требования прямо
   * в адресе — страницы не тратятся впустую, и реже прилетает 403.
   *
   * Две вещи иначе не получить вовсе: цвета в карточке каталога нет,
   * а завершённые торги идут вперемешку с открытыми.
   *
   * Выдача рисуется скриптом и догружается кнопкой, номеров страниц в адресе
   * нет — источник одностраничный. Для узких запросов этого хватает:
   * чёрные Tesla 2022+ на ходу укладываются в одну выдачу.
   */
  buildCatalogUrl(
    bucketKey,
    pageNumber,
    filters = {}
  ) {
    const makeFromBucket =
      String(bucketKey).startsWith("make:")
        ? String(bucketKey).slice("make:".length)
        : null;

    const params = new URLSearchParams({
      "search-type": "filters",
      type: "Automobile",

      // Только открытые торги: по завершённым ставку делать уже поздно.
      status: "Active",

      // Обязательные признаки версии — задаём на источнике, а не после.
      "start-code": "Run and Drive",

      make: filters.make || makeFromBucket || "All",
      model: (Array.isArray(filters.models) && filters.models.length === 1)
        ? filters.models[0]
        : "All",

      "year-from": String(filters.yearFrom || 1900),
      "year-to": String(filters.yearTo || new Date().getFullYear() + 1),

      "auction-type": (Array.isArray(filters.auctionTypes) && filters.auctionTypes.length === 1)
        ? filters.auctionTypes[0]
        : "All",
    });

    const optional = {
      "exterior-color": filters.exteriorColors,
      "fuel-type": filters.fuelTypes,
      "body-style": filters.bodyStyles,
      "drive-type": filters.driveTypes,
      transmission: filters.transmissions,
    };

    // Площадка принимает по одному значению на поле: если запрошено
    // несколько, сузить на источнике нельзя — отсеем как раньше, у себя.
    for (const [key, values] of Object.entries(optional)) {
      if (Array.isArray(values) && values.length === 1)
        params.set(key, values[0]);
    }

    if (Number.isFinite(filters.mileageMin))
      params.set("odometer-from", String(filters.mileageMin));

    if (Number.isFinite(filters.mileageMax))
      params.set("odometer-to", String(filters.mileageMax));

    return `https://bid.cars/en/search/results?${params.toString()}`;
  }

  // ============================================================
  // ОБНОВЛЕНИЕ BID.CARS
  // ============================================================

  async refreshSource({
    bucketKey,
    startPage = 1,
    pageLimit = 1,
    filters = {},
    targetMatches = null,
    existingVehicles = [],
  }) {
    /*
     * Резидентный прокси здесь так и не был подключён, в отличие от сбора
     * фотографий и слежения за ставками. С прямого адреса Hetzner Cloudflare
     * отдаёт 403 — обход стабильно обрывался на седьмой странице, теряя
     * остаток выдачи.
     */
    const proxy = process.env.PROXY_SERVER
      ? {
          server: process.env.PROXY_SERVER,
          username: process.env.PROXY_USERNAME,
          password: process.env.PROXY_PASSWORD,
        }
      : undefined;

    const browser =
      await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
        ...(proxy ? { proxy } : {}),
      });

    const context =
      await browser.newContext({
        userAgent:
          "Mozilla/5.0 " +
          "(Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 " +
          "Chrome/124 Safari/537.36",

        // Английская версия: подписи полей совпадают с тем, что видит
        // пользователь, и не приходится держать переводы меток.
        locale: "en-US",

        viewport: {
          width: 1440,
          height: 1000,
        },

        extraHTTPHeaders: {
          "Accept-Language":
            "en-US,en;q=0.9",
        },

        ignoreHTTPSErrors: Boolean(proxy),
      });

    const page =
      await context.newPage();

    const collected = [];

    let lastSourceUrl = null;
    let pagesFetched = 0;
    let lastPageFetched = 0;
    let lastSuccessfulStatus = null;

    let partialRefresh = false;
    let partialHttpStatus = null;
    let catalogExhausted = false;
    let stopReason = "page_budget";

    const safeStartPage =
      Math.max(
        1,
        this.toPositiveInt(
          startPage,
          1
        )
      );

    const safePageLimit =
      Math.max(
        1,
        this.toPositiveInt(
          pageLimit,
          1
        )
      );

    let endPage =
      Math.min(
        this.maxSafePages,
        safeStartPage +
          safePageLimit -
          1
      );

    try {
      console.log(
        "\n🚙 BID.CARS CATALOG REFRESH"
      );

      console.log(
        `Source scope: ${bucketKey}`
      );

      /*
       * Поиск с фильтрами не разбит на страницы: номера в адресе он
       * игнорирует, а догрузка идёт кнопкой на самой странице. Повторный
       * запрос того же URL Cloudflare принимает за долбёж и отвечает 403,
       * так что второй заход не только бесполезен, но и вреден.
       */
      endPage = safeStartPage;

      console.log(
        `Страницы: ${safeStartPage}..${endPage}`
      );

      for (
        let pageNumber =
          safeStartPage;
        pageNumber <= endPage;
        pageNumber++
      ) {
        const url =
          this.buildCatalogUrl(
            bucketKey,
            pageNumber,
            filters
          );

        lastSourceUrl = url;

        console.log(
          `🌐 page ${pageNumber}: ${url}`
        );

        const response =
          await page.goto(
            url,
            {
              waitUntil:
                "domcontentloaded",

              timeout: 60000,
            }
          );

        // ------------------------------------------------------
        // НЕТ RESPONSE
        // ------------------------------------------------------

        if (!response) {
          if (
            collected.length > 0
          ) {
            console.log(
              `⚠️ page ${pageNumber}: ответа нет. ` +
              `Сохраняем ${collected.length} уже полученных лотов.`
            );

            partialRefresh =
              true;

            stopReason =
              "no_response_partial";

            break;
          }

          throw new BidCarsSourceError(
            "Bid.Cars did not return a response",
            null,
            "NO_RESPONSE"
          );
        }

        const status =
          response.status();

        console.log(
          `   HTTP ${status} -> ${page.url()}`
        );

        // ------------------------------------------------------
        // HTTP 429
        // ------------------------------------------------------

        if (status === 429) {
          const retryAfter =
            this.parseRetryAfter(
              await response.headerValue(
                "retry-after"
              )
            );

          if (
            collected.length > 0
          ) {
            console.log(
              `⚠️ page ${pageNumber}: HTTP 429. ` +
              `Сохраняем ${collected.length} уже полученных лотов.`
            );

            partialRefresh =
              true;

            partialHttpStatus =
              429;

            stopReason =
              "rate_limit_partial";

            break;
          }

          throw new BidCarsRateLimitError(
            "Bid.Cars rate limit reached",
            retryAfter
          );
        }

        // ------------------------------------------------------
        // HTTP 403 / ДРУГИЕ HTTP ERRORS
        // ------------------------------------------------------

        if (status >= 400) {
          if (
            collected.length > 0
          ) {
            console.log(
              `⚠️ page ${pageNumber}: HTTP ${status}. ` +
              `Сохраняем ${collected.length} уже полученных лотов.`
            );

            partialRefresh =
              true;

            partialHttpStatus =
              status;

            stopReason =
              "http_error_partial";

            break;
          }

          throw new BidCarsSourceError(
            `Bid.Cars returned HTTP ${status}`,
            status,
            "HTTP_ERROR"
          );
        }

        lastSuccessfulStatus =
          status;

        /*
         * Каталог приходил готовым с сервера, а выдачу поиска рисует скрипт:
         * без ожидания в HTML пусто, и обход молча возвращал ноль лотов.
         * Ждём появления самих карточек, а не фиксированную паузу —
         * она либо коротка на медленном прокси, либо тратится впустую.
         */
        try {
          await page.waitForSelector(
            'a[href*="/lot/"]',
            { timeout: 20000 }
          );
        } catch {
          // Пустая выдача — законный результат узкого запроса,
          // отличить её от недогруза можно только по числу лотов ниже.
        }

        await page.waitForTimeout(
          900
        );

        const html =
          await page.content();

        const forcedFuelType =
          bucketKey ===
          "make:tesla"
            ? "Electric"
            : null;

        const parsed =
          this.parseListingPage(
            html,
            page.url(),
            {
              forcedFuelType,
            }
          );

        console.log(
          `   Parsed lots: ${parsed.length}`
        );

        collected.push(
          ...parsed
        );

        pagesFetched += 1;

        lastPageFetched =
          pageNumber;

        // Пустая страница после первой означает фактический конец
        // каталога в этом source-scope.
        if (
          pageNumber > 1 &&
          parsed.length === 0
        ) {
          catalogExhausted =
            true;

          stopReason =
            "catalog_exhausted";

          break;
        }

        // Адаптивная остановка: как только локальный реестр +
        // новые страницы дали достаточный пул под текущий запрос,
        // дальше Bid.Cars не листаем.
        if (
          Number.isFinite(
            targetMatches
          ) &&
          targetMatches > 0
        ) {
          const combined =
            this.deduplicate([
              ...collected,
              ...existingVehicles,
            ]);

          const matchCount =
            this.filterAndRank(
              combined,
              filters,
              targetMatches
            ).length;

          console.log(
            `   Matches after page ${pageNumber}: ${matchCount}/${targetMatches}`
          );

          if (
            matchCount >=
            targetMatches
          ) {
            stopReason =
              "target_reached";

            break;
          }
        }

        if (
          pageNumber < endPage
        ) {
          await page.waitForTimeout(
            1400
          );
        }
      }

      const listings =
        this.deduplicate(
          collected
        );

      if (
        listings.length === 0
      ) {
        console.log(
          "ℹ️ В этом диапазоне страниц валидных автомобильных лотов нет."
        );
      } else {
        console.log(
          `✅ Собрано уникальных автомобильных лотов: ${listings.length}`
        );
      }

      return {
        listings,

        httpStatus:
          lastSuccessfulStatus ||
          200,

        lastSourceUrl,

        pagesFetched,

        lastPageFetched,

        partialRefresh,

        partialHttpStatus,

        catalogExhausted,

        stopReason,
      };
    } finally {
      await page
        .close()
        .catch(() => {});

      await context
        .close()
        .catch(() => {});

      await browser
        .close()
        .catch(() => {});
    }
  }

  // ============================================================
  // ПАРСИНГ КАТАЛОГА
  // ============================================================

  parseListingPage(
    html,
    sourceUrl,
    options = {}
  ) {
    const $ =
      cheerio.load(html);

    const listings = [];

    const seen =
      new Set();

    const forcedFuelType =
      options.forcedFuelType ||
      null;

    $('a[href*="/lot/"]').each(
      (_, el) => {
        const href =
          $(el).attr("href") ||
          "";

        if (!href) {
          return;
        }

        const absoluteUrl =
          href.startsWith(
            "http"
          )
            ? href
            : `https://bid.cars${href}`;

        const urlInfo =
          this.parseLotUrl(
            absoluteUrl
          );

        if (
          !urlInfo ||
          seen.has(
            urlInfo.lotNumber
          )
        ) {
          return;
        }

        // ------------------------------------------------------
        // ИЩЕМ DOM-КОНТЕЙНЕР КАРТОЧКИ
        // ------------------------------------------------------

        let container =
          $(el);

        let parent =
          $(el).parent();

        for (
          let depth = 0;
          depth < 12 &&
          parent.length;
          depth++
        ) {
          const text =
            this.elementText(
              $,
              parent
            );

          const hasId =
            text.includes(
              urlInfo.lotNumber
            ) ||
            (
              urlInfo.vin &&
              text.includes(
                urlInfo.vin
              )
            );

          if (hasId) {
            container =
              parent;
          }

          if (
            hasId &&
            /Przebieg|Mileage|Uszkodzenie|Aktualna oferta|Current Bid|Dokument|Lokalizacja|Status/i.test(
              text
            )
          ) {
            container =
              parent;

            break;
          }

          parent =
            parent.parent();
        }

        const text =
          this.elementText(
            $,
            container
          );

        // ======================================================
        // ФИЛЬТР: ТОЛЬКО АВТОМОБИЛИ
        // ======================================================

        if (
          this.isExcludedVehicleType(
            urlInfo,
            text
          )
        ) {
          console.log(
            `   ⛔ Пропущен неавтомобильный лот ${urlInfo.lotNumber}: ` +
            `${urlInfo.make || ""} ${urlInfo.model || ""}`.trim()
          );

          return;
        }

        // ------------------------------------------------------
        // VIN
        // ------------------------------------------------------

        const vinMatch =
          text.match(
            /\b[A-HJ-NPR-Z0-9]{17}\b/i
          );

        // ------------------------------------------------------
        // YEAR
        // ------------------------------------------------------

        const yearMatch =
          text.match(
            /\b(20\d{2})\b/
          );

        const vin =
          urlInfo.vin ||
          (
            vinMatch
              ? vinMatch[0]
                  .toUpperCase()
              : null
          );

        const year =
          urlInfo.year ||
          (
            yearMatch
              ? Number(
                  yearMatch[1]
                )
              : null
          );

        if (
          !vin ||
          !year
        ) {
          return;
        }

        /*
         * Добавляем в seen только после проверки,
         * что это валидный автомобильный lot.
         */
        seen.add(
          urlInfo.lotNumber
        );

        // ------------------------------------------------------
        // ПОЛЯ КАРТОЧКИ КАТАЛОГА
        //
        // Подписи идут в тексте одной строкой, в таком порядке:
        //   Milage → Seller → Sale doc. → Location → Damage → Status
        //   → Current Bid → Buy Now → Opened auction → Key
        //
        // "Milage" — опечатка самой площадки, не наша. Польские подписи
        // оставлены на случай, когда сайт отдаёт локаль по-своему.
        // ------------------------------------------------------

        const NEXT_LABEL =
          "(?:Milage|Mileage|Odometer|Przebieg|Seller|Sprzedawca|" +
          "Sale doc\\.|Sale Document|Dokument|Location|Lokalizacja|" +
          "Damage|Uszkodzenie|Status|Current Bid|Aktualna oferta|" +
          "Buy Now|Opened auction|Key)";

        // Значение тянется до следующей подписи или до цены: после Status
        // в той же строке идёт оценка аукциона, и без этой границы
        // состояние запуска захватывало полкарточки.
        const field = (label) =>
          text.match(
            new RegExp(
              // Пробела между полями может не быть: на странице поиска
              // подписи идут слитно — "(58k km)Seller: ---Sale doc.: ...".
              `${label}\\s*:?\\s*(.+?)(?=\\s*${NEXT_LABEL}\\s*:?|\\s*\\$|$)`,
              "i"
            )
          );

        /*
         * Комплектация стоит в заголовке карточки после запятой и перед
         * VIN: "2021 Tesla Model 3, Long Range Dual Motor 5YJ3E1EB...".
         * В адресе лота её нет, поэтому берём отсюда — иначе запрос
         * "Performance" ни на что не влияет и в рисках потом значится
         * "комплектация не подтверждена".
         */
        const trimMatch =
          text.match(
            /,\s*([^,\n]{2,40}?)\s+[A-HJ-NPR-Z0-9]{17}\b/i
          );

        const mileageMatch =
          text.match(
            /(?:Milage|Przebieg|Mileage|Odometer)\s*:?\s*([\d\s.,]+)\s*(k)?\s*(?:mi|mile|miles|mil)?/i
          );

        const bidMatch =
          text.match(
            /(?:Aktualna oferta|Current Bid|Oferta)\s*:?\s*\$?\s*([\d,.]+)/i
          );

        const buyNowMatch =
          text.match(
            /Buy Now\s*:?\s*\$?\s*([\d,.]+)/i
          );

        const sellerMatch = field("(?:Seller|Sprzedawca)");
        const titleMatch = field("(?:Sale doc\\.|Sale Document|Dokument)");
        const locationMatch = field("(?:Location|Lokalizacja)");
        const statusMatch = field("(?:Status|Start code)");

        /*
         * Повреждения приходят одним полем через вертикальную черту:
         * "Collision | Rear" — сначала основное, затем дополнительное.
         */
        const damageParts = (field("(?:Damage|Uszkodzenie)")?.[1] || "")
          .split("|")
          .map(part => this.clean(part))
          .filter(Boolean);

        const keyMatch =
          text.match(
            /\bKey\s+(Present|Missing|Not present|Unknown)\b/i
          );

        const retailMatch =
          text.match(
            /(?:Estimated Retail Value|Retail Value|ACV)\s*:?\s*\$?\s*([\d,.]+)/i
          );

        listings.push({
          source:
            "bid.cars",

          vehicleType:
            "car",

          auction:
            this.auctionFromLotNumber(
              urlInfo.lotNumber
            ),

          lotNumber:
            urlInfo.lotNumber,

          vin,

          make:
            urlInfo.make,

          model:
            urlInfo.model,

          year,

          currentBid:
            bidMatch
              ? this.parseMoney(
                  bidMatch[1]
                )
              : null,

          trim:
            trimMatch
              ? this.clean(
                  trimMatch[1]
                )
              : null,

          /*
           * Площадка присылает заголовок уже обрезанным: в разметке лежит
           * "Long Range Dual M...", полного названия нет ни в title, ни в
           * адресе лота. По такому огрызку нельзя отсекать: за многоточием
           * у "All-Wheel Drive/L..." вполне может стоять Performance.
           */
          trimTruncated:
            trimMatch
              ? /\u2026|\.\.\.$/.test(this.clean(trimMatch[1]))
              : null,

          currency:
            "USD",

          mileage:
            this.parseMileage(
              mileageMatch
            ),

          primaryDamage:
            damageParts[0] || null,

          secondaryDamage:
            damageParts[1] || null,

          keyPresence:
            keyMatch
              ? this.clean(
                  keyMatch[1]
                )
              : null,

          buyNowUsd:
            buyNowMatch
              ? this.parseMoney(
                  buyNowMatch[1]
                )
              : null,

          seller:
            sellerMatch
              ? this.clean(
                  sellerMatch[1]
                )
              : null,

          runAndDrive:
            statusMatch
              ? this.clean(
                  statusMatch[1]
                )
              : null,

          titleType:
            titleMatch
              ? this.clean(
                  titleMatch[1]
                )
              : null,

          location:
            locationMatch
              ? this.clean(
                  locationMatch[1]
                )
              : null,

          fuelType:
            forcedFuelType ||
            this.extractFuelType(
              text
            ),

          bodyStyle:
            this.extractBodyStyle(
              text
            ),

          driveType:
            this.extractDriveType(
              text
            ),

          transmission:
            this.extractTransmission(
              text
            ),

          // Дата торгов, остаток времени и оценка аукциона лежат
          // в той же строке, что и статус запуска.
          ...parseAuctionTiming(text),

          estimatedRetailValue:
            retailMatch
              ? this.parseMoney(
                  retailMatch[1]
                )
              : null,

          url:
            absoluteUrl ||
            sourceUrl,

          images:
            this.extractImages(
              $,
              container
            ),
        });
      }
    );

    return listings;
  }

  // ============================================================
  // ИСКЛЮЧЕНИЕ НЕ-АВТОМОБИЛЕЙ
  // ============================================================

  isExcludedVehicleType(
    urlInfo,
    text
  ) {
    const identity =
      this.norm(
        `${urlInfo.make || ""} ${urlInfo.model || ""} ${text || ""}`
      );

    const excludedPatterns = [
      /\bmotorcycle\b/,
      /\bmotorbike\b/,
      /\belectric bike\b/,
      /\be-bike\b/,
      /\bebike\b/,
      /\bbike\b/,
      /\bscooter\b/,
      /\bmoped\b/,
      /\batv\b/,
      /\bquad\b/,
      /\bside by side\b/,
      /\butv\b/,
      /\bgolf cart\b/,
      /\bgo kart\b/,
      /\bsnowmobile\b/,
      /\bmotocykl\b/,
      /\bskuter\b/,
      /\bмотоцикл\b/,
      /\bскутер\b/,
      /\bмопед\b/,
      /\bквадроцикл\b/,
    ];

    return excludedPatterns.some(
      (pattern) =>
        pattern.test(
          identity
        )
    );
  }

  // ============================================================
  // LOT URL
  // ============================================================

  parseLotUrl(url) {
    const value =
      String(
        url || ""
      );

    const lot =
      value.match(
        /\/lot\/([01]-\d+)/i
      );

    if (!lot) {
      return null;
    }

    const vin =
      value.match(
        /([A-HJ-NPR-Z0-9]{17})(?:[/?#]|$)/i
      );

    const year =
      value.match(
        /\/lot\/[01]-\d+\/(20\d{2})-/i
      );

    const slug =
      value.match(
        /\/lot\/[01]-\d+\/(?:20\d{2})-([^/?#]+?)(?:-[A-HJ-NPR-Z0-9]{17})?(?:[/?#]|$)/i
      );

    const vehicle =
      slug
        ? this.splitVehicleSlug(
            slug[1]
          )
        : {
            make: null,
            model: null,
          };

    return {
      lotNumber:
        lot[1],

      vin:
        vin
          ? vin[1]
              .toUpperCase()
          : null,

      year:
        year
          ? Number(
              year[1]
            )
          : null,

      make:
        vehicle.make,

      model:
        vehicle.model,
    };
  }

  // ============================================================
  // MAKE / MODEL
  // ============================================================

  splitVehicleSlug(slug) {
    const value =
      String(
        slug || ""
      );

    const lower =
      value.toLowerCase();

    const makes = [
      ["mercedes-benz", "Mercedes-Benz"],
      ["land-rover", "Land Rover"],
      ["volkswagen", "Volkswagen"],
      ["chevrolet", "Chevrolet"],
      ["mitsubishi", "Mitsubishi"],
      ["hyundai", "Hyundai"],
      ["porsche", "Porsche"],
      ["toyota", "Toyota"],
      ["subaru", "Subaru"],
      ["nissan", "Nissan"],
      ["tesla", "Tesla"],
      ["lexus", "Lexus"],
      ["mazda", "Mazda"],
      ["honda", "Honda"],
      ["dodge", "Dodge"],
      ["volvo", "Volvo"],
      ["ford", "Ford"],
      ["audi", "Audi"],
      ["jeep", "Jeep"],
      ["mini", "Mini"],
      ["kia", "KIA"],
      ["bmw", "BMW"],
      ["ram", "RAM"],
      ["rivian", "Rivian"],
      ["lucid", "Lucid"],
      ["polestar", "Polestar"],
      ["genesis", "Genesis"],
      ["acura", "Acura"],
      ["buick", "Buick"],
      ["infiniti", "Infiniti"],
      ["lincoln", "Lincoln"],
      ["cadillac", "Cadillac"],
      ["chrysler", "Chrysler"],
    ];

    for (
      const [
        slugMake,
        make,
      ] of makes
    ) {
      if (
        lower === slugMake ||
        lower.startsWith(
          `${slugMake}-`
        )
      ) {
        const model =
          value
            .slice(
              slugMake.length
            )
            .replace(
              /^-/,
              ""
            )
            .split("-")
            .filter(Boolean)
            .join(" ");

        return {
          make,

          model:
            model ||
            null,
        };
      }
    }

    const parts =
      value
        .split("-")
        .filter(Boolean);

    return {
      make:
        parts[0] ||
        null,

      model:
        parts.length > 1
          ? parts
              .slice(1)
              .join(" ")
          : null,
    };
  }

  // ============================================================
  // AUCTION
  // ============================================================

  auctionFromLotNumber(
    lotNumber
  ) {
    if (
      String(
        lotNumber
      ).startsWith(
        "1-"
      )
    ) {
      return "Copart";
    }

    if (
      String(
        lotNumber
      ).startsWith(
        "0-"
      )
    ) {
      return "IAAI";
    }

    return null;
  }

  // ============================================================
  // FILTERING
  // ============================================================

  filterAndRank(
    vehicles,
    filters,
    maxResults
  ) {
    const candidates = this
      .deduplicate(
        vehicles
      )

      .filter(
        (car) =>
          car.vehicleType !==
          "non_car"
      );

    /*
     * Жёсткие требования версии: лот без Run and Drive и без страхового
     * продавца не рассматриваем независимо от фильтров поиска. Отсев
     * логируем — если разбор этих двух полей сломается, здесь молча
     * исчезнут все лоты, и это нужно замечать.
     */
    /*
     * Продавца площадка показывает не всегда: примерно у половины лотов
     * в выдаче стоит прочерк. Отсекать их здесь значит терять половину
     * поиска из-за того, чего мы просто ещё не знаем.
     *
     * Поэтому на входе отбрасываем только тех, чей продавец известен и
     * не подходит. Неизвестные идут дальше и проверяются после визита на
     * страницу лота — туда сборщик фотографий всё равно заходит.
     */
    const eligible = candidates.filter((car) => {
      if (!isRunAndDrive(this.normalizeStartCode(car.runAndDrive)))
        return false;

      const seller = checkSeller(car.seller);

      return seller.ok || !seller.known;
    });

    const unknownSellers = eligible.filter(
      car => !checkSeller(car.seller).known
    ).length;

    /*
     * Отсев видно только в логе, а пользователю нужно понимать, почему
     * из трёх сотен лотов до него дошло два десятка — иначе пустая выдача
     * неотличима от поломки.
     */
    this.lastRequirementStats = {
      scanned: candidates.length,
      eligible: eligible.length,
      rejected: candidates.length - eligible.length,
      unknownSellers,
      at: new Date().toISOString(),
    };

    if (
      candidates.length > 0 &&
      eligible.length < candidates.length
    ) {
      console.log(
        `   Run and Drive + страховой продавец: ` +
        `оставлено ${eligible.length} из ${candidates.length}` +
        (unknownSellers > 0
          ? `, из них ${unknownSellers} с непрочитанным продавцом — проверим на странице лота`
          : "")
      );
    }

    return eligible

      .map(
        (car) => ({
          ...car,

          ...this.evaluateFilters(
            car,
            filters
          ),
        })
      )

      .filter(
        (car) =>
          car.filterStatus !==
          "MISMATCH"
      )

      .sort(
        (a, b) =>
          (
            a.filterStatus ===
            "MATCH"
              ? 0
              : 1
          ) -
          (
            b.filterStatus ===
            "MATCH"
              ? 0
              : 1
          )
      )

      .slice(
        0,
        maxResults
      );
  }

  evaluateFilters(
    car,
    filters
  ) {
    const unknownFields =
      [];

    const mismatchFields =
      [];

    const unknown =
      (field) => {
        if (
          !unknownFields.includes(
            field
          )
        ) {
          unknownFields.push(
            field
          );
        }
      };

    const mismatch =
      (field) => {
        if (
          !mismatchFields.includes(
            field
          )
        ) {
          mismatchFields.push(
            field
          );
        }
      };

    // MAKE

    if (filters.make) {
      if (!car.make) {
        unknown("make");
      } else if (
        this.norm(
          car.make
        ) !==
        this.norm(
          filters.make
        )
      ) {
        mismatch(
          "make"
        );
      }
    }

    // MODEL

    if (
      filters.models.length
    ) {
      if (!car.model) {
        unknown("model");
      } else if (
        !filters.models.some(
          (model) =>
            this
              .norm(
                car.model
              )
              .includes(
                this.norm(
                  model
                )
              )
        )
      ) {
        mismatch(
          "model"
        );
      }
    }

    // YEAR

    this.numberFilter(
      "year",
      car.year,
      filters.yearFrom,
      filters.yearTo,
      unknown,
      mismatch
    );

    // MILEAGE

    this.numberFilter(
      "mileage",
      car.mileage,
      filters.mileageMin,
      filters.mileageMax,
      unknown,
      mismatch
    );

    // FUEL

    this.categoryFilter(
      "fuelType",
      car.fuelType,
      filters.fuelTypes,
      this.normalizeFuelType.bind(
        this
      ),
      unknown,
      mismatch
    );

    // BODY

    this.categoryFilter(
      "bodyStyle",
      car.bodyStyle,
      filters.bodyStyles,
      this.normalizeBodyStyle.bind(
        this
      ),
      unknown,
      mismatch
    );

    // DRIVE

    this.categoryFilter(
      "driveType",
      car.driveType,
      filters.driveTypes,
      this.normalizeDriveType.bind(
        this
      ),
      unknown,
      mismatch
    );

    // TRANSMISSION

    this.categoryFilter(
      "transmission",
      car.transmission,
      filters.transmissions,
      this.normalizeTransmission.bind(
        this
      ),
      unknown,
      mismatch
    );

    // START CODE

    this.categoryFilter(
      "runAndDrive",
      car.runAndDrive,
      filters.startCodes,
      this.normalizeStartCode.bind(
        this
      ),
      unknown,
      mismatch
    );

    // AUCTION

    if (
      filters.auctionTypes.length
    ) {
      if (!car.auction) {
        unknown(
          "auction"
        );
      } else if (
        !filters.auctionTypes.includes(
          this.norm(
            car.auction
          )
        )
      ) {
        mismatch(
          "auction"
        );
      }
    }

    const filterStatus =
      mismatchFields.length
        ? "MISMATCH"
        : unknownFields.length
        ? "PARTIAL"
        : "MATCH";

    return {
      filterStatus,
      unknownFields,
      mismatchFields,
    };
  }

  numberFilter(
    field,
    actual,
    min,
    max,
    unknown,
    mismatch
  ) {
    if (
      min === null &&
      max === null
    ) {
      return;
    }

    if (
      actual == null
    ) {
      unknown(
        field
      );

      return;
    }

    const value =
      Number(actual);

    if (
      min !== null &&
      value < min
    ) {
      mismatch(
        field
      );
    }

    if (
      max !== null &&
      value > max
    ) {
      mismatch(
        field
      );
    }
  }

  categoryFilter(
    field,
    actual,
    wanted,
    normalizer,
    unknown,
    mismatch
  ) {
    if (
      !wanted.length
    ) {
      return;
    }

    if (
      actual == null ||
      actual === ""
    ) {
      unknown(
        field
      );

      return;
    }

    if (
      !wanted.includes(
        normalizer(
          actual
        )
      )
    ) {
      mismatch(
        field
      );
    }
  }

  // ============================================================
  // NORMALIZE FILTERS
  // ============================================================

  normalizeFilters(
    options = {}
  ) {
    return {
      make:
        options.make
          ? String(
              options.make
            ).trim()
          : null,

      models:
        this.arr(
          options.models
        ),

      yearFrom:
        this.num(
          options.yearFrom
        ),

      yearTo:
        this.num(
          options.yearTo
        ),

      mileageMin:
        this.num(
          options.mileageMin
        ),

      mileageMax:
        this.num(
          options.mileageMax
        ),

      fuelTypes:
        this
          .arr(
            options.fuelTypes
          )
          .map(
            (value) =>
              this.normalizeFuelType(
                value
              )
          ),

      bodyStyles:
        this
          .arr(
            options.bodyStyles
          )
          .map(
            (value) =>
              this.normalizeBodyStyle(
                value
              )
          ),

      driveTypes:
        this
          .arr(
            options.driveTypes
          )
          .map(
            (value) =>
              this.normalizeDriveType(
                value
              )
          ),

      transmissions:
        this
          .arr(
            options.transmissions
          )
          .map(
            (value) =>
              this.normalizeTransmission(
                value
              )
          ),

      startCodes:
        this
          .arr(
            options.startCodes
          )
          .map(
            (value) =>
              this.normalizeStartCode(
                value
              )
          ),

      auctionTypes:
        this
          .arr(
            options.auctionTypes
          )
          .map(
            (value) =>
              this.norm(
                value
              )
          ),

      /*
       * Цвет задаётся только на источнике: в карточке каталога его нет,
       * а на странице лота он появляется уже после дорогого визита.
       * Значения оставляем как есть — площадка ждёт "Black", а не "black".
       */
      exteriorColors:
        this.arr(
          options.exteriorColors
        ),
    };
  }

  // ============================================================
  // FUEL
  // ============================================================

  normalizeFuelType(value) {
    const v =
      this.norm(
        value
      );

    if (
      v === "electric" ||
      v === "ev" ||
      v.includes(
        "elektrycz"
      ) ||
      v.includes(
        "элект"
      )
    ) {
      return "electric";
    }

    if (
      v === "gasoline" ||
      v === "gas" ||
      v === "petrol" ||
      v.includes(
        "benzyn"
      ) ||
      v.includes(
        "бензин"
      )
    ) {
      return "gasoline";
    }

    if (
      v === "diesel" ||
      v.includes(
        "дизел"
      )
    ) {
      return "diesel";
    }

    if (
      v === "hybrid" ||
      v.includes(
        "hybryd"
      ) ||
      v.includes(
        "гибрид"
      )
    ) {
      return "hybrid";
    }

    return "other";
  }

  extractFuelType(text) {
    const v =
      this.norm(
        text
      );

    if (
      v.includes(
        "electric"
      ) ||
      v.includes(
        "elektrycz"
      )
    ) {
      return "Electric";
    }

    if (
      v.includes(
        "benzyna"
      ) ||
      v.includes(
        "gasoline"
      ) ||
      v.includes(
        "petrol"
      )
    ) {
      return "Gasoline";
    }

    if (
      v.includes(
        "diesel"
      )
    ) {
      return "Diesel";
    }

    if (
      v.includes(
        "hybrid"
      ) ||
      v.includes(
        "hybryd"
      )
    ) {
      return "Hybrid";
    }

    return null;
  }

  // ============================================================
  // BODY STYLE
  // ============================================================

  normalizeBodyStyle(value) {
    const v =
      this.norm(
        value
      );

    if (
      v.includes(
        "sedan"
      ) ||
      v.includes(
        "седан"
      )
    ) {
      return "sedan";
    }

    if (
      v.includes(
        "coupe"
      ) ||
      v.includes(
        "купе"
      )
    ) {
      return "coupe";
    }

    if (
      v.includes(
        "suv"
      ) ||
      v.includes(
        "sport utility"
      )
    ) {
      return "suv";
    }

    if (
      v.includes(
        "crossover"
      ) ||
      v.includes(
        "кроссовер"
      )
    ) {
      return "crossover";
    }

    if (
      v.includes(
        "hatchback"
      ) ||
      v.includes(
        "liftback"
      ) ||
      v.includes(
        "хэтчбек"
      )
    ) {
      return "hatchback";
    }

    if (
      v.includes(
        "pickup"
      ) ||
      v.includes(
        "пикап"
      )
    ) {
      return "pickup";
    }

    if (
      v.includes(
        "wagon"
      ) ||
      v.includes(
        "универсал"
      )
    ) {
      return "wagon";
    }

    if (
      v.includes(
        "convertible"
      ) ||
      v.includes(
        "roadster"
      ) ||
      v.includes(
        "кабриолет"
      )
    ) {
      return "convertible";
    }

    if (
      v.includes(
        "minivan"
      )
    ) {
      return "minivan";
    }

    if (
      v.includes(
        "van"
      )
    ) {
      return "van";
    }

    return "other";
  }

  extractBodyStyle(text) {
    const normalized =
      this.normalizeBodyStyle(
        text
      );

    const values = {
      sedan: "Sedan",
      coupe: "Coupe",
      suv: "SUV",
      crossover: "Crossover",
      hatchback: "Hatchback",
      pickup: "Pickup",
      wagon: "Wagon",
      convertible: "Convertible",
      minivan: "Minivan",
      van: "Van",
    };

    return (
      values[
        normalized
      ] ||
      null
    );
  }

  // ============================================================
  // DRIVE TYPE
  // ============================================================

  normalizeDriveType(value) {
    const v =
      this.norm(
        value
      );

    if (
      v === "awd" ||
      v === "4wd" ||
      v === "4x4" ||
      v.includes(
        "all wheel"
      ) ||
      v.includes(
        "cztery kola"
      ) ||
      v.includes(
        "полный"
      )
    ) {
      return "awd";
    }

    if (
      v === "fwd" ||
      v.includes(
        "front wheel"
      ) ||
      v.includes(
        "przednie kola"
      ) ||
      v.includes(
        "передний"
      )
    ) {
      return "fwd";
    }

    if (
      v === "rwd" ||
      v.includes(
        "rear wheel"
      ) ||
      v.includes(
        "tylne kola"
      ) ||
      v.includes(
        "задний"
      )
    ) {
      return "rwd";
    }

    return "other";
  }

  extractDriveType(text) {
    const normalized =
      this.normalizeDriveType(
        text
      );

    if (
      normalized ===
      "awd"
    ) {
      return "All wheel drive";
    }

    if (
      normalized ===
      "fwd"
    ) {
      return "Front wheel drive";
    }

    if (
      normalized ===
      "rwd"
    ) {
      return "Rear wheel drive";
    }

    return null;
  }

  // ============================================================
  // TRANSMISSION
  // ============================================================

  normalizeTransmission(value) {
    const v =
      this.norm(
        value
      );

    if (
      v.includes(
        "automatic"
      ) ||
      v.includes(
        "automatycz"
      ) ||
      v.includes(
        "автомат"
      )
    ) {
      return "automatic";
    }

    if (
      v.includes(
        "manual"
      ) ||
      v.includes(
        "механ"
      )
    ) {
      return "manual";
    }

    return "other";
  }

  extractTransmission(text) {
    const normalized =
      this.normalizeTransmission(
        text
      );

    if (
      normalized ===
      "automatic"
    ) {
      return "Automatic";
    }

    if (
      normalized ===
      "manual"
    ) {
      return "Manual";
    }

    return null;
  }

  // ============================================================
  // START CODE
  // ============================================================

  normalizeStartCode(value) {
    const v =
      this.norm(
        value
      );

    // Значение может прийти уже приведённым — так его передаёт фильтр
    // поиска. Без этой проверки "run_and_drive" превращался в "other",
    // и фильтр не совпадал ни с одной машиной.
    if (
      [
        "run_and_drive",
        "starts",
        "stationary",
        "unknown",
        "other",
      ].includes(v)
    ) {
      return v;
    }

    if (
      v.includes(
        "run and drive"
      ) ||
      v.includes(
        "odpala i rusza"
      ) ||
      v.includes(
        "заводится и едет"
      )
    ) {
      return "run_and_drive";
    }

    if (
      v.includes(
        "vehicle starts"
      ) ||
      v === "starts" ||
      v.includes(
        "odpala"
      ) ||
      v.includes(
        "заводится"
      )
    ) {
      return "starts";
    }

    if (
      v.includes(
        "stationary"
      ) ||
      v.includes(
        "nie odpala"
      )
    ) {
      return "stationary";
    }

    if (
      v.includes(
        "no information"
      ) ||
      v.includes(
        "brak informacji"
      )
    ) {
      return "unknown";
    }

    return "other";
  }

  // ============================================================
  // RESPONSE / META
  // ============================================================

  makeResult(
    listings,
    filters,
    bucket,
    bucketKey,
    dataStatus,
    sourceUpdateStatus,
    coverage = null
  ) {
    const resolvedCoverage =
      coverage ||
      this.getCoverageState(
        bucket,
        listings.length,
        listings.length
      );

    let message =
      "Поиск завершён.";

    if (listings.length) {
      if (
        resolvedCoverage.status ===
        "sufficient"
      ) {
        message =
          `Найден достаточный пул кандидатов (${resolvedCoverage.matchCount}). ` +
          "Дополнительные страницы Bid.Cars не запрашивались.";
      } else if (
        resolvedCoverage.complete
      ) {
        message =
          `Каталог source-scope просмотрен полностью. Найдено ${resolvedCoverage.matchCount} подходящих автомобилей.`;
      } else {
        message =
          `Найдено ${resolvedCoverage.matchCount} подходящих автомобилей в уже просмотренной части каталога.`;
      }
    } else if (
      resolvedCoverage.complete
    ) {
      message =
        "Каталог source-scope просмотрен полностью: по заданным фильтрам подходящих автомобилей не найдено.";
    } else if (
      resolvedCoverage.status ===
      "limit_reached"
    ) {
      message =
        "В просмотренной части каталога совпадений нет. Достигнут безопасный лимит глубины; отсутствие автомобилей во всём Bid.Cars не подтверждено.";
    } else {
      message =
        "В локальном реестре и просмотренной части каталога совпадений пока нет. Покрытие неполное, поэтому это НЕ означает отсутствие таких автомобилей на Bid.Cars.";
    }

    if (
      sourceUpdateStatus ===
        "rate_limited"
    ) {
      message =
        "Bid.Cars ограничил частоту обновления. Используются последние сохранённые данные. " +
        message;
    } else if (
      sourceUpdateStatus ===
        "source_error"
    ) {
      message =
        "Источник Bid.Cars сейчас недоступен. Используются последние сохранённые данные. " +
        message;
    } else if (
      sourceUpdateStatus ===
        "cooldown"
    ) {
      message =
        "Повторное обращение к Bid.Cars временно отложено. Используются сохранённые данные. " +
        message;
    }

    return {
      listings,

      filters,

      meta: {
        source:
          "bid.cars",

        sourceBucket:
          bucketKey,

        dataStatus,

        sourceUpdateStatus,

        lastUpdated:
          bucket.lastSuccessfulUpdateAt ||
          null,

        nextRefreshAllowedAt:
          bucket.nextAllowedAt ||
          null,

        failureCount:
          bucket.failureCount ||
          0,

        lastHttpStatus:
          bucket.lastHttpStatus ??
          null,

        lastErrorCode:
          bucket.lastErrorCode ||
          null,

        cacheSize:
          bucket.vehicles.length,

        pagesFetched:
          bucket.pagesFetched ||
          0,

        highestPageFetched:
          bucket.highestPageFetched ||
          bucket.pagesFetched ||
          0,

        lastRunPagesFetched:
          bucket.lastRunPagesFetched ||
          0,

        catalogExhausted:
          Boolean(
            bucket.catalogExhausted
          ),

        coverageCompletedAt:
          bucket.coverageCompletedAt ||
          null,

        coverageStatus:
          resolvedCoverage.status,

        coverageComplete:
          Boolean(
            resolvedCoverage.complete
          ),

        candidatePoolSize:
          resolvedCoverage.matchCount,

        targetPoolSize:
          resolvedCoverage.targetPoolSize,

        maxSafePages:
          this.maxSafePages,

        partialRefresh:
          Boolean(
            bucket.partialRefresh
          ),

        partialHttpStatus:
          bucket.partialHttpStatus ??
          null,

        lastStopReason:
          bucket.lastStopReason ||
          null,

        message,
      },
    };
  }

  // ============================================================
  // CACHE / LOCAL REGISTRY
  // ============================================================

  emptyCache() {
    return {
      version: 3,
      source: "bid.cars",
      buckets: {},
    };
  }

  emptyBucket(bucketKey) {
    return {
      bucketKey,

      vehicles: [],

      lastAttemptAt:
        null,

      lastSuccessfulUpdateAt:
        null,

      nextAllowedAt:
        null,

      failureCount:
        0,

      lastHttpStatus:
        null,

      lastError:
        null,

      lastErrorCode:
        null,

      lastRetryAfterSeconds:
        null,

      lastSourceUrl:
        null,

      // Совместимость со старым полем.
      pagesFetched:
        0,

      // Реальное накопленное покрытие source-scope.
      highestPageFetched:
        0,

      lastRunPagesFetched:
        0,

      catalogExhausted:
        false,

      coverageCompletedAt:
        null,

      lastExpansionAt:
        null,

      lastStopReason:
        null,

      partialRefresh:
        false,

      partialHttpStatus:
        null,

      queryHistory: {},
    };
  }

  getBucket(
    cache,
    key
  ) {
    // Миграция старого bucket "electric": фактически старый код
    // использовал там URL Tesla, поэтому переносим его в make:tesla.
    if (
      !cache.buckets[key] &&
      key === "make:tesla" &&
      cache.buckets.electric
    ) {
      cache.buckets[key] = {
        ...cache.buckets.electric,
        bucketKey: key,
      };
    }

    if (
      !cache.buckets[key]
    ) {
      cache.buckets[key] =
        this.emptyBucket(
          key
        );
    }

    const current =
      cache.buckets[key];

    const normalized = {
      ...this.emptyBucket(key),
      ...current,

      bucketKey:
        key,

      vehicles:
        Array.isArray(
          current.vehicles
        )
          ? current.vehicles
          : [],

      highestPageFetched:
        current.highestPageFetched ||
        current.pagesFetched ||
        0,

      queryHistory:
        current.queryHistory &&
        typeof current.queryHistory ===
          "object"
          ? current.queryHistory
          : {},
    };

    cache.buckets[key] =
      normalized;

    return normalized;
  }

  findByLotNumber(lotNumber) {
    if (!lotNumber)
      return null;

    const target = String(lotNumber);
    const cache = this.loadCache();

    for (const bucket of Object.values(cache.buckets || {})) {
      const found = (bucket.vehicles || []).find(
        (vehicle) => String(vehicle.lotNumber) === target
      );

      if (found)
        return found;
    }

    return null;
  }

  loadCache() {
    try {
      if (
        !fs.existsSync(
          this.cacheFile
        )
      ) {
        return this.emptyCache();
      }

      const parsed =
        JSON.parse(
          fs.readFileSync(
            this.cacheFile,
            "utf8"
          )
        );

      if (
        [2, 3].includes(
          parsed.version
        ) &&
        parsed.buckets
      ) {
        parsed.version = 3;

        return parsed;
      }

      return this.emptyCache();
    } catch (error) {
      console.log(
        "⚠️ Cache read error:",
        error.message
      );

      return this.emptyCache();
    }
  }

  saveCache(cache) {
    fs.mkdirSync(
      path.dirname(
        this.cacheFile
      ),
      {
        recursive: true,
      }
    );

    const tmp =
      `${this.cacheFile}.tmp`;

    fs.writeFileSync(
      tmp,
      JSON.stringify(
        cache,
        null,
        2
      ),
      "utf8"
    );

    fs.renameSync(
      tmp,
      this.cacheFile
    );
  }

  // ============================================================
  // RATE LIMIT
  // ============================================================

  resolveRetryAfterMs(
    seconds,
    failureCount
  ) {
    if (
      Number.isFinite(
        seconds
      ) &&
      seconds > 0
    ) {
      return Math.max(
        seconds * 1000,
        this.minRefreshMs
      );
    }

    const index =
      Math.min(
        Math.max(
          failureCount - 1,
          0
        ),

        this
          .backoffScheduleMs
          .length - 1
      );

    return this
      .backoffScheduleMs[
        index
      ];
  }

  parseRetryAfter(value) {
    if (!value) {
      return null;
    }

    const number =
      Number(value);

    if (
      Number.isFinite(
        number
      ) &&
      number >= 0
    ) {
      return number;
    }

    const time =
      new Date(
        value
      ).getTime();

    if (
      !Number.isFinite(
        time
      )
    ) {
      return null;
    }

    return Math.max(
      0,

      Math.ceil(
        (
          time -
          Date.now()
        ) /
          1000
      )
    );
  }

  // ============================================================
  // DOM HELPERS
  // ============================================================

  elementText(
    $,
    element
  ) {
    const extras =
      [];

    element
      .find("img")
      .each(
        (_, img) => {
          const alt =
            $(img).attr(
              "alt"
            );

          const title =
            $(img).attr(
              "title"
            );

          if (alt) {
            extras.push(
              alt
            );
          }

          if (title) {
            extras.push(
              title
            );
          }
        }
      );

    return (
      `${element.text()} ${extras.join(" ")}`
        .replace(
          /\s+/g,
          " "
        )
        .trim()
    );
  }

  extractImages(
    $,
    container
  ) {
    const images =
      [];

    container
      .find("img")
      .each(
        (_, img) => {
          const src =
            $(img).attr(
              "src"
            ) ||
            $(img).attr(
              "data-src"
            ) ||
            $(img).attr(
              "data-lazy-src"
            ) ||
            "";

          let url =
            null;

          if (
            src.startsWith(
              "http"
            )
          ) {
            url =
              src;
          } else if (
            src.startsWith(
              "//"
            )
          ) {
            url =
              `https:${src}`;
          } else if (
            src.startsWith(
              "/"
            )
          ) {
            url =
              `https://bid.cars${src}`;
          }

          if (
            url &&
            !images.includes(
              url
            )
          ) {
            images.push(
              url
            );
          }
        }
      );

    return images;
  }

  // ============================================================
  // VALUES
  // ============================================================

  parseMileage(match) {
    if (!match) {
      return null;
    }

    const raw =
      String(
        match[1] || ""
      )
        .trim()
        .replace(
          /\s/g,
          ""
        );

    let value;

    if (match[2]) {
      value =
        Number(
          raw.replace(
            ",",
            "."
          )
        ) * 1000;
    } else {
      value =
        Number(
          raw.replace(
            /[,.]/g,
            ""
          )
        );
    }

    if (
      !Number.isFinite(
        value
      )
    ) {
      return null;
    }

    const number =
      Math.round(
        value
      );

    /*
     * 999k / 999999 часто означает неизвестный пробег.
     */
    if (
      number >=
      999000
    ) {
      return null;
    }

    return number;
  }

  parseMoney(value) {
    const number =
      Number(
        String(
          value || ""
        ).replace(
          /[,\s]/g,
          ""
        )
      );

    return Number.isFinite(
      number
    )
      ? number
      : null;
  }

  clean(value) {
    if (
      value == null
    ) {
      return null;
    }

    return (
      String(value)
        .replace(
          /\s+/g,
          " "
        )
        .trim() ||
      null
    );
  }

  arr(value) {
    if (
      value == null ||
      value === ""
    ) {
      return [];
    }

    return (
      Array.isArray(
        value
      )
        ? value
        : [value]
    ).filter(
      (item) =>
        item != null &&
        String(
          item
        ).trim() !==
          ""
    );
  }

  num(value) {
    if (
      value == null ||
      value === ""
    ) {
      return null;
    }

    const number =
      Number(value);

    return Number.isFinite(
      number
    )
      ? number
      : null;
  }

  toPositiveInt(
    value,
    fallback
  ) {
    const number =
      Number(value);

    return (
      Number.isInteger(
        number
      ) &&
      number > 0
        ? number
        : fallback
    );
  }

  norm(value) {
    return String(
      value || ""
    )
      .trim()
      .toLowerCase()
      .normalize(
        "NFD"
      )
      .replace(
        /[\u0300-\u036f]/g,
        ""
      );
  }

  sourceSlug(value) {
    return this
      .norm(value)
      .replace(
        /&/g,
        " and "
      )
      .replace(
        /[^a-z0-9]+/g,
        "-"
      )
      .replace(
        /^-+|-+$/g,
        ""
      );
  }

  vehicleKey(car) {
    if (!car) {
      return null;
    }

    if (car.lotNumber) {
      return `lot:${car.lotNumber}`;
    }

    if (car.vin) {
      return `vin:${car.vin}`;
    }

    if (car.url) {
      return `url:${car.url}`;
    }

    return null;
  }

  mergeVehicles(
    existing,
    incoming,
    seenAt
  ) {
    const map =
      new Map();

    for (
      const car of
      Array.isArray(existing)
        ? existing
        : []
    ) {
      const key =
        this.vehicleKey(car);

      if (key) {
        map.set(
          key,
          {
            ...car,

            firstSeenAt:
              car.firstSeenAt ||
              car.sourceFetchedAt ||
              seenAt,

            lastSeenAt:
              car.lastSeenAt ||
              car.sourceFetchedAt ||
              null,

            bidHistory:
              Array.isArray(
                car.bidHistory
              )
                ? car.bidHistory
                : [],
          }
        );
      }
    }

    for (
      const car of
      Array.isArray(incoming)
        ? incoming
        : []
    ) {
      const key =
        this.vehicleKey(car);

      if (!key) {
        continue;
      }

      const previous =
        map.get(key);

      if (!previous) {
        const bidHistory =
          Number.isFinite(
            Number(
              car.currentBid
            )
          ) &&
          car.currentBid != null
            ? [
                {
                  at: seenAt,

                  value:
                    Number(
                      car.currentBid
                    ),
                },
              ]
            : [];

        map.set(
          key,
          {
            ...car,

            firstSeenAt:
              seenAt,

            lastSeenAt:
              seenAt,

            lastChangedAt:
              seenAt,

            sourceFetchedAt:
              seenAt,

            bidHistory,
          }
        );

        continue;
      }

      const next = {
        ...previous,
      };

      let changed =
        false;

      for (
        const [
          field,
          value,
        ] of Object.entries(car)
      ) {
        // Не затираем уже известные данные случайным null/"" из
        // карточки каталога. Источник может неполно отрисовать поле.
        if (
          value == null ||
          value === ""
        ) {
          continue;
        }

        if (
          Array.isArray(value) &&
          value.length === 0
        ) {
          continue;
        }

        const before =
          next[field];

        const beforeComparable =
          Array.isArray(before)
            ? JSON.stringify(before)
            : before;

        const afterComparable =
          Array.isArray(value)
            ? JSON.stringify(value)
            : value;

        if (
          beforeComparable !==
          afterComparable
        ) {
          changed = true;
        }

        next[field] =
          value;
      }

      const previousBid =
        previous.currentBid;

      const nextBid =
        next.currentBid;

      const previousBidNumber =
        previousBid == null
          ? null
          : Number(previousBid);

      const nextBidNumber =
        nextBid == null
          ? null
          : Number(nextBid);

      const bidHistory =
        Array.isArray(
          previous.bidHistory
        )
          ? [
              ...previous.bidHistory,
            ]
          : [];

      if (
        Number.isFinite(
          nextBidNumber
        ) &&
        (
          !Number.isFinite(
            previousBidNumber
          ) ||
          previousBidNumber !==
            nextBidNumber
        )
      ) {
        bidHistory.push({
          at: seenAt,

          value:
            nextBidNumber,
        });
      }

      next.bidHistory =
        bidHistory.slice(-100);

      next.firstSeenAt =
        previous.firstSeenAt ||
        previous.sourceFetchedAt ||
        seenAt;

      next.lastSeenAt =
        seenAt;

      next.sourceFetchedAt =
        seenAt;

      if (changed) {
        next.lastChangedAt =
          seenAt;
      }

      map.set(
        key,
        next
      );
    }

    return Array.from(
      map.values()
    );
  }

  deduplicate(list) {
    const seen =
      new Set();

    return list.filter(
      (car) => {
        const key =
          car.lotNumber ||
          car.vin ||
          car.url;

        if (
          !key ||
          seen.has(
            key
          )
        ) {
          return false;
        }

        seen.add(
          key
        );

        return true;
      }
    );
  }
}

module.exports =
  BidCarsProvider;