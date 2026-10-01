const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PcarmarketScraper = require("../src/rare/pcarmarket-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-rare-pcarmarket-"));

/*
 * Упрощённый, но по форме честный слепок того, что PCARMARKET реально
 * вшивает в HTML: самоссылающиеся $R[N] = {...} вместо обычного JSON
 * (так SSR React Query переживает общие объекты без дублирования).
 * Разбор ищет запись по queryKey ["basta","search",...], не по месту
 * в структуре — подставить сюда минимальный, но валидный кусок с тем же
 * ключом достаточно для честной проверки.
 */
const html = ({ page = 1, totalPages = 1, nodes = [] }) => `<!DOCTYPE html><html><body>
<script>(self.$R=self.$R||{})["tsr"]=[];</script>
<script>
self.$_TSR={router:{dehydratedData:{dehydratedQueryClient:{queries:[
  {queryKey:["auth","session"],state:{data:null}},
  {queryKey:["basta","search",{type:"ITEM"}],state:{data:{search:{
    pageInfo:{page:${page},pageSize:24,totalPages:${totalPages},hasNextPage:${page < totalPages},hasPreviousPage:${page > 1},totalRecords:${nodes.length}},
    resultCount:${nodes.length},
    edges:${JSON.stringify(nodes.map(node => ({ node })))}
  }}}}
]}}}};
</script>
</body></html>`;

/*
 * /results несёт тот же гидратационный кэш, но с запросом, уже
 * отфильтрованным площадкой на status:ITEM_CLOSED — тот же queryKey
 * ["basta","search",...], отличается только filterBy внутри него.
 */
const resultsHtml = ({ nodes = [] } = {}) => `<!DOCTYPE html><html><body>
<script>(self.$R=self.$R||{})["tsr"]=[];</script>
<script>
self.$_TSR={router:{dehydratedData:{dehydratedQueryClient:{queries:[
  {queryKey:["basta","search",{type:"ITEM",filterBy:"status:ITEM_CLOSED && (itemResult:[ITEM_RESULT_WON,ITEM_RESULT_WON_UNDER_THE_RESERVE] || (offerEnabled:false && buyNowEnabled:false))"}],state:{data:{search:{
    resultCount:${nodes.length},
    edges:${JSON.stringify(nodes.map(node => ({ node })))}
  }}}}
]}}}};
</script>
</body></html>`;

const noResults = async () => resultsHtml();

const vehicleNode = (overrides = {}) => ({
  __typename: "Item",
  id: "n1",
  slugFullPath: "pcar/test-slug-1/full-title-slug",
  title: "1994 Test Vehicle 5-Speed",
  currency: "USD",
  currentBid: 500000,
  totalBids: 3,
  estimates: { low: 0, high: 0 },
  images: [{ url: "https://assets.basta.app/x1.jpg", order: 0 }, { url: "https://assets.basta.app/x2.jpg", order: 1 }],
  dates: { openDate: "2026-01-01T00:00:00Z", closingEnd: new Date(Date.now() + 72 * 3600 * 1000).toISOString() },
  status: "ITEM_OPEN",
  schema: {
    data: {
      schemaName: "Vehicle",
      make: "Porsche",
      model: "911",
      vin: "WP0AA0911XS000001",
      odometerValue: 42000,
      odometerUnit: "Miles",
      transmission: "5-Speed Manual",
      sellerType: "Private Party",
    },
  },
  ...overrides,
});

test("fetchActiveListings keeps only Vehicle items, drops watches/memorabilia", async () => {
  const scraper = new PcarmarketScraper({
    dataDir: tmpDir(),
    fetchPage: async () => html({ nodes: [
      vehicleNode(),
      vehicleNode({ id: "n2", schema: { data: { schemaName: "Watches" } } }),
    ] }),
    log: () => {},
  });

  const nodes = await scraper.fetchActiveListings();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, "n1");
});

test("fetchActiveListings walks every page up to totalPages", async () => {
  const calls = [];
  const scraper = new PcarmarketScraper({
    dataDir: tmpDir(),
    fetchPage: async (page) => {
      calls.push(page);
      return html({ page, totalPages: 3, nodes: [vehicleNode({ id: `n${page}` })] });
    },
    log: () => {},
  });

  const nodes = await scraper.fetchActiveListings();
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(nodes.map(n => n.id), ["n1", "n2", "n3"]);
});

test("run() maps a vehicle node to a RareLot with Russian transmission/ownerType and the lot URL", async () => {
  const dataDir = tmpDir();
  const scraper = new PcarmarketScraper({
    dataDir,
    fetchPage: async () => html({ nodes: [vehicleNode()] }),
    fetchResultsPage: noResults,
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);

  const lot = lots[0];
  assert.equal(lot.id, "pcarmarket-n1");
  assert.equal(lot.source, "PCARMARKET");
  assert.equal(lot.sourceUrl, "https://www.pcarmarket.com/auction/test-slug-1");
  assert.equal(lot.make, "Porsche");
  assert.equal(lot.model, "911");
  assert.equal(lot.mileage, 42000);
  assert.equal(lot.transmission, "5-ступенчатая механика");
  assert.equal(lot.vin, "WP0AA0911XS000001");
  assert.equal(lot.ownerType, "Частное лицо");
  assert.equal(lot.currentBid, 5000); // 500000 центов -> $5000
  assert.equal(lot.estimateMin, null); // 0 значит "не выставлена"
  assert.equal(lot.photoUrl, "https://assets.basta.app/x1.jpg");
  assert.equal(lot.status, "open"); // закрытие через 72ч — дальше окна "скоро закрывается"

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() converts kilometers to miles for odometerUnit other than Miles", async () => {
  const dataDir = tmpDir();
  const scraper = new PcarmarketScraper({
    dataDir,
    fetchPage: async () => html({ nodes: [vehicleNode({
      schema: { data: { ...vehicleNode().schema.data, odometerValue: 160934, odometerUnit: "Kilometers" } },
    })] }),
    fetchResultsPage: noResults,
    log: () => {},
  });

  const [lot] = await scraper.run();
  assert.equal(lot.mileage, 100000);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() marks a lot closing within 48h, and still closing (not ended) once closesAt has passed but the platform still calls it open", async () => {
  const dataDir = tmpDir();
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  const scraper = new PcarmarketScraper({
    dataDir,
    fetchPage: async () => html({ nodes: [
      vehicleNode({ id: "closing", dates: { closingEnd: soon } }),
      vehicleNode({ id: "still-open", dates: { closingEnd: past }, status: "ITEM_OPEN" }),
    ] }),
    fetchResultsPage: noResults,
    log: () => {},
  });

  const lots = await scraper.run();
  assert.equal(lots.find(l => l.id === "pcarmarket-closing").status, "closing");
  // Тот же класс бага, что нашли и починили на Cars & Bids и Hemmings
  // 01.10 (баг от Mikita): расписанная closingEnd в прошлом не значит,
  // что площадка уже подвела итог.
  assert.equal(lots.find(l => l.id === "pcarmarket-still-open").status, "closing");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() marks a lot ended once the platform itself says so, not just by time", async () => {
  const dataDir = tmpDir();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  const scraper = new PcarmarketScraper({
    dataDir,
    fetchPage: async () => html({ nodes: [vehicleNode({ dates: { closingEnd: past }, status: "ITEM_CLOSED" })] }),
    fetchResultsPage: noResults,
    log: () => {},
  });

  const [lot] = await scraper.run();
  assert.equal(lot.status, "ended");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() reports only genuinely new lots to alerts.checkAfterRun, comparing against the previous run", async () => {
  const dataDir = tmpDir();
  const calls = [];
  const alerts = { checkAfterRun: async (args) => { calls.push(args); } };

  const scraper = new PcarmarketScraper({
    dataDir,
    alerts,
    fetchPage: async () => html({ nodes: [vehicleNode({ id: "n1" })] }),
    fetchResultsPage: noResults,
    log: () => {},
  });

  await scraper.run();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].newLots.map(l => l.id), ["pcarmarket-n1"]);

  scraper.fetchPage = async () => html({ nodes: [vehicleNode({ id: "n1" }), vehicleNode({ id: "n2" })] });
  await scraper.run();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].newLots.map(l => l.id), ["pcarmarket-n2"]);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() writes a failed status and rethrows when the page can't be parsed", async () => {
  const dataDir = tmpDir();
  const scraper = new PcarmarketScraper({
    dataDir,
    fetchPage: async () => "<html><body>страница проверки Cloudflare, без данных</body></html>",
    log: () => {},
  });

  await assert.rejects(() => scraper.run());
  const status = scraper.readStatus();
  assert.equal(status.ok, false);
  assert.match(status.error, /не нашёл/);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

const closedNode = (overrides = {}) => vehicleNode({
  id: "sold-1",
  status: "ITEM_CLOSED",
  itemResult: "WON",
  currentBid: 500000, // $5000
  dates: { closingEnd: "2026-09-30T20:10:39Z" },
  ...overrides,
});

test("run() archives a closed lot from /results into the Stats sold archive", async () => {
  const dataDir = tmpDir();
  const scraper = new PcarmarketScraper({
    dataDir,
    fetchPage: async () => html({ nodes: [] }), // активных лотов нет — архив продаж не зависит от них
    fetchResultsPage: async () => resultsHtml({ nodes: [closedNode()] }),
    log: () => {},
  });

  await scraper.run();
  const sold = scraper.readSold();
  assert.equal(sold.length, 1);
  assert.equal(sold[0].id, "pcarmarket-sold-1");
  assert.equal(sold[0].make, "Porsche");
  assert.equal(sold[0].salePrice, 5000);
  assert.equal(sold[0].sold, true);
  assert.equal(sold[0].soldAt, "2026-09-30T20:10:39Z");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() prefers the Buy Now sale amount over the last bid", async () => {
  const dataDir = tmpDir();
  const scraper = new PcarmarketScraper({
    dataDir,
    fetchPage: async () => html({ nodes: [] }),
    fetchResultsPage: async () => resultsHtml({ nodes: [closedNode({
      notifications: [{ __typename: "ItemSoldNotification", amount: 320000, currency: "USD", source: "BUY", date: "2026-10-01T15:08:10Z" }],
    })] }),
    log: () => {},
  });

  await scraper.run();
  const [sold] = scraper.readSold();
  assert.equal(sold.salePrice, 3200, "Buy Now обходит текущую ставку совсем — notifications важнее currentBid");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("run() does not duplicate a lot already in the sold archive", async () => {
  const dataDir = tmpDir();
  const scraper = new PcarmarketScraper({
    dataDir,
    fetchPage: async () => html({ nodes: [] }),
    fetchResultsPage: async () => resultsHtml({ nodes: [closedNode()] }),
    log: () => {},
  });

  await scraper.run();
  await scraper.run(); // то же самое ещё раз — /results всегда отдаёт недавние закрытия заново

  assert.equal(scraper.readSold().length, 1);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a reserve-not-met result is kept but marked unsold", async () => {
  const dataDir = tmpDir();
  const scraper = new PcarmarketScraper({
    dataDir,
    fetchPage: async () => html({ nodes: [] }),
    fetchResultsPage: async () => resultsHtml({ nodes: [closedNode({ id: "unsold-1", itemResult: null })] }),
    log: () => {},
  });

  await scraper.run();
  const [sold] = scraper.readSold();
  assert.equal(sold.sold, false);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
