require("dotenv").config();

const BidCarsProvider = require("../src/providers/bidcars");
const Orchestrator = require("../src/orchestrator");

async function main() {
  console.log("");
  console.log("⚡ TESLA AUCTION AGENT");
  console.log("==============================================");
  console.log("");

  try {
    // 1. Создаем источник данных
    const bidCars = new BidCarsProvider();

    // 2. Получаем Tesla
    const listings = await bidCars.searchTesla({
      models: ["Model 3", "Model Y", "Model X"],
      yearFrom: 2021,
      maxResults: 20,
    });

    console.log("");
    console.log(`✅ Получено автомобилей: ${listings.length}`);
    console.log("");

    // 3. Проверяем данные
    console.log("📦 Полученные лоты:");
    console.log(JSON.stringify(listings, null, 2));

    if (listings.length === 0) {
      console.log("⚠️ Подходящих автомобилей не найдено.");
      return;
    }

    // 4. Передаем лоты вашему оркестратору
    console.log("");
    console.log("🤖 Передаем автомобили агентам...");
    console.log("");

    const orchestrator = new Orchestrator();

    const result = await orchestrator.analyzeAuction(listings);

    console.log("");
    console.log("==============================================");
    console.log("🏁 АНАЛИЗ ЗАВЕРШЕН");
    console.log("==============================================");

    if (result) {
      console.log(result);
    }
  } catch (error) {
    console.error("");
    console.error("❌ Ошибка Tesla Agent:");
    console.error(error);
    process.exit(1);
  }
}

main();