const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const SkillLoader = require("./skills/skill-loader");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

class AgentManager {
  constructor(configPath = path.join(__dirname, "../agents/config.json")) {
    this.config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    this.skillLoader = new SkillLoader();
  }

  async callAgent(agentId, userMessage) {
  const agentConfig = this.config[agentId];

  if (!agentConfig) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const promptPath = path.join(
    __dirname,
    "../agents",
    agentConfig.promptFile
  );

  const systemPrompt = fs.readFileSync(
    promptPath,
    "utf8"
  );

  const knowledgeContext =
    this.skillLoader.buildKnowledgeContext(agentId);

  const fullSystemPrompt = knowledgeContext
    ? `${systemPrompt}

---

# ДОПОЛНИТЕЛЬНЫЕ ЗНАНИЯ АГЕНТА

${knowledgeContext}`
    : systemPrompt;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: fullSystemPrompt,
    messages: [
      {
        role: "user",
        content: userMessage
      }
    ],
  });

  return response.content[0].text;
}

}

class Orchestrator {
  constructor() {
    this.agentManager = new AgentManager();
  }

  async analyzeAuction(auctionListings) {
    console.log("🎯 Оркестратор запущен...\n");

    // -------------------------------------------------
    // 1. Нормализуем входные данные
    // -------------------------------------------------

    const cars = auctionListings.map((car, index) =>
      this.normalizeCar(car, index)
    );

    console.log(`📦 Получено автомобилей: ${cars.length}`);

    // -------------------------------------------------
    // 2. SELECTOR
    // -------------------------------------------------

    console.log("📋 Этап 1: Подбор авто...");

    const selectorResponse = await this.agentManager.callAgent(
      "selector",
      `
Вот доступные лоты:

${JSON.stringify(cars, null, 2)}

Выбери наиболее перспективные автомобили.

ВАЖНО:
- не придумывай отсутствующие данные;
- используй только автомобили из переданного списка;
- сохрани поля make, model, year, lotNumber и vin;
- верни JSON-массив выбранных автомобилей.
`
    );

    let selectedCars = [];

    try {
      const parsed = this.parseAgentJson(selectorResponse);

      if (Array.isArray(parsed)) {
        selectedCars = parsed;
      } else if (Array.isArray(parsed.selected)) {
        selectedCars = parsed.selected;
      }
    } catch (error) {
      console.log(
        "⚠️ Selector вернул неподходящий JSON. Используем первые автомобили."
      );
    }

    // -------------------------------------------------
    // ВАЖНО:
    // восстанавливаем выбранные автомобили
    // из ОРИГИНАЛЬНОГО массива.
    //
    // LLM не должен менять исходные данные автомобиля.
    // -------------------------------------------------

    selectedCars = this.resolveSelectedCars(
      selectedCars,
      cars
    );

    if (selectedCars.length === 0) {
      selectedCars = cars.slice(0, Math.min(3, cars.length));
    }

    console.log(`✅ Выбрано: ${selectedCars.length}\n`);

    // -------------------------------------------------
    // 3. Анализ каждого автомобиля
    // -------------------------------------------------

    const results = [];

    for (const car of selectedCars) {
      console.log(
        `🔧 Анализ ${car.make} ${car.model} ${car.year || ""}...`
      );

      // ------------------------
      // Assessor
      // ------------------------

      const assessorPromise = this.agentManager.callAgent(
        "assessor",
        `
Оцени автомобиль:

${JSON.stringify(car, null, 2)}

Определи:

1. характер повреждений;
2. риски ремонта;
3. ориентировочную минимальную стоимость ремонта;
4. ориентировочную максимальную стоимость ремонта;
5. основные неизвестные факторы.

Не придумывай отсутствующие факты.

Верни JSON:

{
  "repairCostMin": number | null,
  "repairCostMax": number | null,
  "risk": "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN",
  "notes": [],
  "unknowns": []
}
`
      );

      // ------------------------
      // Market Analyst
      // ------------------------

      const marketPromise = this.agentManager.callAgent(
        "marketAnalyst",
        `
Проанализируй потенциальную рыночную стоимость автомобиля:

${JSON.stringify(car, null, 2)}

Не придумывай точную цену, если данных недостаточно.

Верни JSON:

{
  "marketValueMin": number | null,
  "marketValueMax": number | null,
  "currency": "${car.currency || "USD"}",
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "notes": []
}
`
      );

      const [assessorResponse, marketResponse] =
        await Promise.all([
          assessorPromise,
          marketPromise,
        ]);

      let assessor = {};
      let market = {};

      try {
        assessor = this.parseAgentJson(assessorResponse);
      } catch (error) {
        console.log("⚠️ Не удалось разобрать ответ assessor.");
      }

      try {
        market = this.parseAgentJson(marketResponse);
      } catch (error) {
        console.log("⚠️ Не удалось разобрать ответ market analyst.");
      }

      // -------------------------------------------------
      // 4. Числовые показатели
      // -------------------------------------------------

      const purchasePrice = this.toNumber(car.currentBid);

      const repairMin = this.toNumber(
        assessor.repairCostMin ??
        assessor.сметная_стоимость_мин
      );

      const repairMax = this.toNumber(
        assessor.repairCostMax ??
        assessor.сметная_стоимость_макс
      );

      const marketMin = this.toNumber(
        market.marketValueMin ??
        market.рыночная_цена_мин
      );

      const marketMax = this.toNumber(
        market.marketValueMax ??
        market.рыночная_цена_макс ??
        market.рекомендованная_цена_продажи
      );

      const repair =
        repairMin !== null && repairMax !== null
          ? (repairMin + repairMax) / 2
          : repairMin ?? repairMax;

      const marketValue =
        marketMin !== null && marketMax !== null
          ? (marketMin + marketMax) / 2
          : marketMin ?? marketMax;

      let roi = null;

      if (
        purchasePrice !== null &&
        repair !== null &&
        marketValue !== null
      ) {
        roi = marketValue - purchasePrice - repair;
      }

      // -------------------------------------------------
      // 5. Решение
      // -------------------------------------------------

      let recommendation = "⚠️ НЕДОСТАТОЧНО ДАННЫХ";

      if (roi !== null) {
        if (roi > 0) {
          recommendation = "✅ РАССМОТРЕТЬ";
        } else {
          recommendation = "❌ ПРОПУСТИТЬ";
        }
      }

      results.push({
        vehicle: {
          make: car.make,
          model: car.model,
          year: car.year,
          vin: car.vin,
          lotNumber: car.lotNumber
        },

        source: car.source,
        auction: car.auction,
        url: car.url,

        currency: car.currency,

        purchasePrice,

        repairCostMin: repairMin,
        repairCostMax: repairMax,
        estimatedRepairCost: repair,

        marketValueMin: marketMin,
        marketValueMax: marketMax,
        estimatedMarketValue: marketValue,

        roi,

        recommendation,

        risk: assessor.risk || "UNKNOWN",

        assessor,
        market
      });
    }

    // -------------------------------------------------
    // 6. Сортировка
    // -------------------------------------------------

    results.sort((a, b) => {
      if (a.roi === null && b.roi === null) return 0;
      if (a.roi === null) return 1;
      if (b.roi === null) return -1;

      return b.roi - a.roi;
    });

    this.generateReport(results);

    return results;
  }

  // =================================================
  // НОРМАЛИЗАЦИЯ
  // =================================================

  normalizeCar(car, index = 0) {
    return {
      id:
        car.id ??
        car.lotNumber ??
        car.lot_number ??
        car.vin ??
        `car-${index}`,

      source:
        car.source ??
        null,

      auction:
        car.auction ??
        null,

      lotNumber:
        car.lotNumber ??
        car.lot_number ??
        car.lot ??
        null,

      vin:
        car.vin ??
        car.VIN ??
        null,

      make:
        car.make ??
        car.марка ??
        null,

      model:
        car.model ??
        car.модель ??
        null,

      year:
        this.toNumber(
          car.year ??
          car.год
        ),

      mileage:
        this.toNumber(
          car.mileage ??
          car.odometer ??
          car.пробег
        ),

      currentBid:
        this.toNumber(
          car.currentBid ??
          car.current_bid ??
          car.price ??
          car.текущая_цена
        ),

      currency:
        car.currency ??
        "USD",

      estimatedRetailValue:
        this.toNumber(
          car.estimatedRetailValue ??
          car.estimated_retail_value
        ),

      primaryDamage:
        car.primaryDamage ??
        car.primary_damage ??
        car.основное_повреждение ??
        null,

      secondaryDamage:
        car.secondaryDamage ??
        car.secondary_damage ??
        car.дополнительное_повреждение ??
        null,

      runAndDrive:
        car.runAndDrive ??
        car.run_and_drive ??
        null,

      titleType:
        car.titleType ??
        car.title_type ??
        null,

      location:
        car.location ??
        null,

      saleDate:
        car.saleDate ??
        car.sale_date ??
        null,

      url:
        car.url ??
        null,

      images:
        Array.isArray(car.images)
          ? car.images
          : []
    };
  }

  // =================================================
  // Сопоставление ответа Selector
  // с исходными автомобилями
  // =================================================

  resolveSelectedCars(selected, originalCars) {
    if (!Array.isArray(selected)) return [];

    const resolved = [];

    for (const selectedCar of selected) {
      const lot =
        selectedCar.lotNumber ??
        selectedCar.lot_number;

      const vin =
        selectedCar.vin ??
        selectedCar.VIN;

      let found = null;

      if (lot) {
        found = originalCars.find(
          car => String(car.lotNumber) === String(lot)
        );
      }

      if (!found && vin) {
        found = originalCars.find(
          car => car.vin === vin
        );
      }

      if (!found) {
        const make =
          selectedCar.make ??
          selectedCar.марка;

        const model =
          selectedCar.model ??
          selectedCar.модель;

        const year =
          selectedCar.year ??
          selectedCar.год;

        found = originalCars.find(
          car =>
            car.make === make &&
            car.model === model &&
            String(car.year) === String(year)
        );
      }

      if (found && !resolved.includes(found)) {
        resolved.push(found);
      }
    }

    return resolved;
  }

  // =================================================
  // JSON от агентов
  // =================================================

  parseAgentJson(text) {
    if (typeof text !== "string") {
      return text;
    }

    let cleaned = text.trim();

    cleaned = cleaned
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    return JSON.parse(cleaned);
  }

  // =================================================
  // Безопасное преобразование числа
  // =================================================

  toNumber(value) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      return null;
    }

    if (typeof value === "number") {
      return Number.isFinite(value)
        ? value
        : null;
    }

    const normalized = String(value)
      .replace(/[^\d.-]/g, "");

    if (!normalized) return null;

    const number = Number(normalized);

    return Number.isFinite(number)
      ? number
      : null;
  }

  // =================================================
  // Отчёт
  // =================================================

  generateReport(results) {
    console.log("\n" + "=".repeat(70));
    console.log("📊 ОТЧЁТ");
    console.log("=".repeat(70));

    results.forEach((result, index) => {
      const car = result.vehicle;

      console.log(
        `\n${index + 1}. ${car.make || "?"} ${car.model || "?"} ${car.year || ""}`
      );

      if (car.lotNumber) {
        console.log(`   Lot: ${car.lotNumber}`);
      }

      if (car.vin) {
        console.log(`   VIN: ${car.vin}`);
      }

      console.log(
        `   Текущая ставка: ${
          result.purchasePrice ?? "нет данных"
        } ${result.currency}`
      );

      console.log(
        `   Ремонт: ${
          result.estimatedRepairCost ?? "нет данных"
        } ${result.currency}`
      );

      console.log(
        `   Рыночная стоимость: ${
          result.estimatedMarketValue ?? "нет данных"
        } ${result.currency}`
      );

      console.log(
        `   ROI: ${
          result.roi ?? "нельзя рассчитать"
        }`
      );

      console.log(
        `   Риск: ${result.risk}`
      );

      console.log(
        `   Решение: ${result.recommendation}`
      );

      if (result.url) {
        console.log(`   ${result.url}`);
      }
    });

    console.log("\n" + "=".repeat(70));
  }
}

module.exports = Orchestrator;