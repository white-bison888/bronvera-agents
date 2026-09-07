const fs = require("fs");
const path = require("path");

const API_URL = "https://api.anthropic.com/v1/messages";

/*
 * Оценку по фотографиям делает отдельная дешёвая модель: задача здесь
 * узкая — разглядеть характер удара, а не рассуждать об экономике.
 */
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `Ты — технический эксперт по аварийным автомобилям с аукционов США.

Тебе показывают фотографии одного лота. Оцени повреждения ТОЛЬКО по тому,
что реально видно на снимках.

Правила:
— не выдумывай повреждения, которых не видно;
— если ракурсов не хватает, честно снижай уверенность;
— различай косметику (бампер, крыло, оптика) и силовые элементы
  (лонжероны, стойки, порог, подрамник, крыша);
— для электромобилей отдельно отмечай риск для батареи и её корпуса;
— срабатывание подушек безопасности отмечай, только если видно салон.

Верни СТРОГО JSON без markdown и без текста вокруг:

{
  "visibleDamage": ["перечень видимых повреждений"],
  "damageZones": ["front|rear|left|right|roof|underbody|interior"],
  "severity": "light|moderate|severe",
  "structuralConcern": true,
  "airbagsDeployed": true,
  "batteryAreaAffected": true,
  "repairPlan": [
    {
      "work": "что именно делать",
      "partsUsd": 0,
      "laborUsd": 0,
      "note": "почему это нужно — что видно на снимке"
    }
  ],
  "repairCostMin": 0,
  "repairCostMax": 0,
  "confidence": "high|medium|low",
  "notes": "краткий вывод одной-двумя фразами"
}

ГДЕ И ПО КАКИМ ЦЕНАМ СЧИТАТЬ РЕМОНТ

Автомобиль покупается на аукционе США и восстанавливается в Польше,
поэтому считай так:

— ЗАПЧАСТИ по ценам мирового рынка в долларах. Для Tesla учитывай,
  что оригинальные кузовные детали дороги, а на распространённые модели
  есть неоригинал и разборка;

— РАБОТА по польским ставкам: примерно 25-40 USD за нормо-час
  в обычном сервисе, 50-70 USD в специализированном по электромобилям.
  Это в два-три раза дешевле американских ставок — не считай по США;

— покраска элемента в Польше обычно 120-250 USD за деталь;

— работы с высоковольтной батареей и её корпусом считай по ставкам
  специализированного сервиса.

repairPlan — перечень конкретных работ. По каждой строке указывай
стоимость запчастей и работы отдельно, чтобы оценку можно было
проверить и оспорить. Не пиши общие фразы вроде «кузовной ремонт» —
называй узлы: бампер, крыло, лонжерон, стойка, дверь, порог.

repairCostMin и repairCostMax — итоговый диапазон по всем работам
из repairPlan, в долларах. Минимум считай при благоприятном сценарии
(скрытых повреждений нет, детали с разборки), максимум — при
неблагоприятном (нужны новые оригинальные детали, повреждения глубже).

Если повреждение лёгкое и хорошо видно, диапазон обязателен.
Ставь null только когда снимков действительно не хватает даже
для грубой оценки — но тогда объясни в notes, чего именно не видно.

airbagsDeployed и batteryAreaAffected ставь null, если по фото не определить.

Тексты в visibleDamage, repairPlan и notes пиши по-русски.`;

// Снимки экрана сохраняются в PNG, скачанные с аукциона — в JPEG.
// Неверно указанный тип API отвергает.
const mediaTypeFor = (file) => {
  const extension = path.extname(file).toLowerCase();

  if (extension === ".png")
    return "image/png";

  if (extension === ".webp")
    return "image/webp";

  return "image/jpeg";
};


class PhotoAssessor {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || "";

    this.cacheFile =
      options.cacheFile ||
      path.join(process.cwd(), "data", "photo-assessments-cache.json");

    // Больше шести ракурсов почти не добавляют информации,
    // а стоимость растёт линейно.
    this.maxPhotos = options.maxPhotos || 6;

    this.model = options.model || MODEL;
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

    return entry ? entry.assessment : null;
  }

  parseAssessment(text) {
    const raw = String(text || "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start)
      return null;

    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  async assessOne(lot, photoFiles) {
    const selected = photoFiles
      .filter(file => fs.existsSync(file))
      .slice(0, this.maxPhotos);

    if (selected.length === 0) {
      return {
        lotNumber: lot.lotNumber,
        available: false,
        reason: "Фотографии лота отсутствуют",
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

    const content = [
      ...selected.map(file => ({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaTypeFor(file),
          data: fs.readFileSync(file).toString("base64"),
        },
      })),
      {
        type: "text",
        text: `Автомобиль: ${context}. Оцени повреждения по фотографиям.`,
      },
    ];

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        // Перечень работ длиннее прежнего ответа: при 1200 он обрывался
        // на середине, и разбор JSON падал.
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();

      throw new Error(
        `Anthropic ${response.status}: ${detail.slice(0, 200)}`
      );
    }

    const payload = await response.json();
    const text = (payload.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");

    const parsed = this.parseAssessment(text);

    if (!parsed) {
      return {
        lotNumber: lot.lotNumber,
        available: false,
        reason: "Модель вернула неразборчивый ответ",
      };
    }

    return {
      lotNumber: lot.lotNumber,
      available: true,
      photosAnalyzed: selected.length,
      ...parsed,
    };
  }

  async assess(lots, photosByLot) {
    if (!this.apiKey)
      throw new Error("ANTHROPIC_API_KEY не задан");

    const cache = this.loadCache();
    let fromCache = 0;
    let analyzed = 0;

    // Лоты разбираем параллельно: запросы идут к разным изображениям
    // и друг друга не ждут, а последовательный разбор пяти машин
    // не укладывался в тайм-аут вызывающего узла.
    const results = await Promise.all(
      lots.map(async (lot) => {
        const key = String(lot.lotNumber);

        if (cache[key]) {
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
            cache[key] = {
              assessment,
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

    if (analyzed > 0)
      this.saveCache(cache);

    console.log(
      `🔍 Оценка по фото: из кэша ${fromCache}, разобрано ${analyzed}`
    );

    return results;
  }
}

module.exports = PhotoAssessor;
