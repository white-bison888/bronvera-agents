class BidCarsProvider {
  constructor() {
    this.baseUrl = "https://bid.cars/ru";
  }

  async searchTesla(options = {}) {
    const {
      models = ["Model 3", "Model Y"],
      yearFrom = 2021,
      maxResults = 20,
    } = options;

    console.log("🚗 Поиск автомобилей на Bid.Cars...");
    console.log(`   Марка: Tesla`);
    console.log(`   Модели: ${models.join(", ")}`);
    console.log(`   Год: от ${yearFrom}`);
    console.log(`   Максимум: ${maxResults}`);

    /*
     * На следующем шаге здесь появится
     * реальное получение данных с Bid.Cars.
     *
     * Пока возвращаем тестовую структуру,
     * максимально близкую к реальному лоту.
     */

    const listings = [
      {
        source: "bid.cars",
        auction: "IAAI",

        lotNumber: "TEST-001",
        vin: "TESTVIN00000000001",

        make: "Tesla",
        model: "Model Y",
        year: 2024,

        currentBid: 11000,
        currency: "USD",

        mileage: null,

        primaryDamage: null,
        secondaryDamage: null,

        runAndDrive: null,
        titleType: null,

        location: null,
        saleDate: null,

        estimatedRetailValue: null,

        url: "https://bid.cars/ru/",

        images: [],
      },

      {
        source: "bid.cars",
        auction: "IAAI",

        lotNumber: "TEST-002",
        vin: "TESTVIN00000000002",

        make: "Tesla",
        model: "Model X",
        year: 2024,

        currentBid: 7100,
        currency: "USD",

        mileage: null,

        primaryDamage: null,
        secondaryDamage: null,

        runAndDrive: null,
        titleType: null,

        location: null,
        saleDate: null,

        estimatedRetailValue: null,

        url: "https://bid.cars/ru/",

        images: [],
      },
    ];

    return listings
      .filter((car) => car.year >= yearFrom)
      .slice(0, maxResults);
  }
}

module.exports = BidCarsProvider;