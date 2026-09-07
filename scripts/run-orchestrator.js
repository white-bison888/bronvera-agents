const path = require("path");

// Ключ берётся из окружения (.env), а не из кода: в репозитории
// его быть не должно.
require("dotenv").config();

const Orchestrator = require(path.join(__dirname, "../src/orchestrator"));

const mockAuction = [
  {
    id: 1,
    марка: "BMW",
    модель: "X5",
    год: 2015,
    пробег: 150000,
    текущая_цена: 450000,
    состояние: "среднее",
    описание: "Кузовные повреждения, двигатель работает",
    целевой_регион: "Московская область",
  },
  {
    id: 2,
    марка: "Mercedes",
    модель: "C-Class",
    год: 2018,
    пробег: 95000,
    текущая_цена: 750000,
    состояние: "хорошее",
    описание: "Минимальные повреждения, чистое ДТП",
    целевой_регион: "Санкт-Петербург",
  },
  {
    id: 3,
    марка: "Audi",
    модель: "A4",
    год: 2016,
    пробег: 120000,
    текущая_цена: 600000,
    состояние: "хорошее",
    описание: "Техническое обслуживание в порядке",
    целевой_регион: "Московская область",
  },
];

async function main() {
  try {
    const orchestrator = new Orchestrator();
    const results = await orchestrator.analyzeAuction(mockAuction);

    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const outputFile = `analysis_${timestamp}.json`;
    require("fs").writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`\n💾 Результаты сохранены в ${outputFile}`);
  } catch (error) {
    console.error("❌ Ошибка:", error.message);
    process.exit(1);
  }
}

main();
