const { measuredCall, measureRun } = require("../observability/usage");
const fs = require("fs");
const { createHash } = require("node:crypto");
const path = require("path");

const { filterUsablePhotos } = require("../photos/quality");

/*
 * Разбор снимков вынесен в отдельный сервис: он держит ключ поставщика,
 * следит за суточным лимитом и сам выбирает модель. Промпт живёт там же —
 * двух копий быть не должно, они разойдутся.
 */
const API_URL = process.env.PHOTO_ASSESS_URL
  || "http://localhost:3002/api/photos/assess";

// Версия нужна, чтобы сбросить кэш, когда в сервисе меняется разбор.
const CACHE_VERSION = process.env.PHOTO_ASSESS_VERSION || "vision-service-1";

class PhotoAssessor {
  constructor(options = {}) {
    this.cacheFile =
      options.cacheFile ||
      path.join(process.cwd(), "data", "photo-assessments-cache.json");

    /*
     * Смотрим все снимки лота. Ограничение в шесть ракурсов ставили ради
     * экономии на платной модели, но сорванная крыша может оказаться
     * ровно на седьмом кадре, а лот при этом пройдёт как целый.
     */
    this.maxPhotos = options.maxPhotos || 0;

    /*
     * Модель выбирает сервис, но привязка кэша к ней остаётся: разбор,
     * сделанный другой моделью, — другой разбор. По умолчанию роль ключа
     * играет адрес сервиса, а CACHE_VERSION поднимают руками, когда там
     * меняется промпт.
     */
    this.model = options.model || API_URL;

    this.cacheVersion = createHash("sha256")
      .update([CACHE_VERSION, this.model].join("|"))
      .digest("hex");

    this.concurrency = 2;
  }

  loadCache() {
    try {
      if (!fs.existsSync(this.cacheFile))
        return {};

      return JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
    } catch (error) {
      console.error("Assessment cache read error:", error.message);

      return {};
    }
  }

  saveCache(cache) {
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });

    const tempFile = `${this.cacheFile}.tmp`;

    fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tempFile, this.cacheFile);
  }

  getCached(lotNumber) {
    const entry = this.loadCache()[String(lotNumber)];

    return entry?.version === this.cacheVersion ? entry.assessment : null;
  }

  async assessOne(lot, photoFiles) {
    const existing = photoFiles.filter(file => fs.existsSync(file));

    /*
     * Проверяем кадры до отправки: белый прямоугольник стоит столько же
     * токенов, сколько настоящая фотография, а ответ по нему всё равно
     * придётся отбросить.
     */
    const { usable, rejected } = await filterUsablePhotos(existing);
    const selected = this.maxPhotos > 0 ? usable.slice(0, this.maxPhotos) : usable;

    if (selected.length === 0) {
      return {
        lotNumber: lot.lotNumber,
        available: false,
        reason: rejected.length > 0
          ? `Снимки непригодны: ${rejected[0].reason}`
          : "Фотографии лота отсутствуют",
        rejectedPhotos: rejected.length,
      };
    }

    const context = [
      lot.year,
      lot.make,
      lot.model,
      lot.primaryDamage ? `заявленное повреждение: ${lot.primaryDamage}` : null,
      lot.fuelType ? `тип: ${lot.fuelType}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    const payload = await measuredCall(
      { component: "vision", lotNumber: String(lot.lotNumber), model: this.model },
      async () => {
        const response = await fetch(API_URL, {
          // Все снимки лота уходят одним запросом, ответ идёт от внешней
          // модели через сервис — на десятке кадров минуты полторы нормально.
          signal: AbortSignal.timeout(300000),
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lotNumber: String(lot.lotNumber),
            context: `Автомобиль: ${context}. Оцени повреждения по фотографиям.`,
            photos: selected.map(file => fs.readFileSync(file).toString("base64")),
          }),
        });

        const body = await response.json().catch(() => null);

        if (!response.ok && !body) {
          throw new Error(`Сервис оценки фото ${response.status}`);
        }

        return body;
      });

    /*
     * Лимит на сегодня исчерпан — это не «повреждений нет». Лот остаётся
     * в очереди и будет разобран, когда лимит обновится.
     */
    if (payload?.deferred) {
      return {
        lotNumber: lot.lotNumber,
        available: false,
        deferred: true,
        reason: payload.reason || "Разбор фотографий перенесён на следующий день",
      };
    }

    if (!payload?.available) {
      return {
        lotNumber: lot.lotNumber,
        available: false,
        reason: payload?.reason || "Оценка по фотографиям не получена",
        rejectedPhotos: rejected.length,
      };
    }

    const parsed = payload.assessment || {};

    /*
     * Ответ «ничего не видно» — это не оценка. Раньше такой ответ всё
     * равно записывался как оценка, и в карточке появлялись «лёгкое
     * повреждение» и «силовые элементы целы», которых никто не видел.
     */
    const noEstimate = !Number.isFinite(parsed.repairCostMin)
      && !Number.isFinite(parsed.repairCostMax);

    if (noEstimate) {
      return {
        lotNumber: lot.lotNumber,
        available: false,
        reason: `Модель не смогла оценить ремонт по фото: ${parsed.notes || "недостаточно ракурсов"}`,
        photosAnalyzed: payload.photosAnalyzed ?? selected.length,
        rejectedPhotos: rejected.length,
      };
    }

    return {
      lotNumber: lot.lotNumber,
      available: true,
      photosAnalyzed: payload.photosAnalyzed ?? selected.length,
      rejectedPhotos: rejected.length,
      visionModel: payload.model || null,
      detector: payload.detector || null,
      ...parsed,
    };
  }

  async assess(lots, photosByLot) {
    return measureRun("photo-assessment", () => this.assessRun(lots, photosByLot));
  }

  async assessRun(lots, photosByLot) {
    const cache = this.loadCache();
    const updates = {};
    let fromCache = 0;
    let analyzed = 0;

    // Лоты разбираем параллельно: запросы идут к разным изображениям
    // и друг друга не ждут, а последовательный разбор пяти машин
    // не укладывался в тайм-аут вызывающего узла.
    const results = [];
    for (let offset = 0; offset < lots.length; offset += this.concurrency) {
      const batch = await Promise.all(
        lots.slice(offset, offset + this.concurrency).map(async (lot) => {
          const key = String(lot.lotNumber);

          const fingerprint = createHash("sha256");
          for (const file of photosByLot[key] || []) {
            if (fs.existsSync(file)) fingerprint.update(fs.readFileSync(file));
          }
          fingerprint.update(JSON.stringify([lot.year, lot.make, lot.model, lot.primaryDamage, lot.fuelType]));
          const photoHash = fingerprint.digest("hex");
          if (cache[key]?.version === this.cacheVersion && cache[key]?.photoHash === photoHash) {
            fromCache += 1;

            return cache[key].assessment;
          }

          try {
            const assessment = await this.assessOne(
              lot,
              photosByLot[key] || []
            );

            // Отсутствие фотографий не кэшируем: снимки могут появиться позже.
            if (assessment.available) {
              updates[key] = {
                assessment,
                version: this.cacheVersion,
                photoHash,
                assessedAt: new Date().toISOString(),
              };

              analyzed += 1;
            }

            return assessment;
          } catch (error) {
            console.error(`   ${key}: ошибка оценки — ${error.message}`);

            return {
              lotNumber: lot.lotNumber,
              available: false,
              reason: `Ошибка оценки: ${error.message}`,
            };
          }
        })
      );

      results.push(...batch);
    }
    if (analyzed > 0)
      this.saveCache({ ...this.loadCache(), ...updates });

    console.log(
      `🔍 Оценка по фото: из кэша ${fromCache}, разобрано ${analyzed}`
    );

    return results;
  }
}

module.exports = PhotoAssessor;
