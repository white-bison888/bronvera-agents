const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GoodingScraper = require("../src/rare/gooding-scraper");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-rare-gooding-"));
const fakeFx = {
  async convert(amount, currency, soldAt) {
    const rate = currency === "EUR" ? 1.1 : 1;
    return { salePrice: Math.round(amount * rate), fxRate: rate, fxDate: String(soldAt).slice(0, 10) };
  },
  async usdPerUnit(currency) {
    return { rate: currency === "EUR" ? 1.1 : 1, rateDate: "2026-10-04" };
  },
};

const sitemap = `<urlset>
<url><loc>https://www.goodingco.com/auction/realized/amelia-island-auctions-2026</loc></url>
<url><loc>https://www.goodingco.com/auction/realized/geared-online-motorcycles</loc></url>
<url><loc>https://www.goodingco.com/auction/realized/geneva-auction-2027</loc></url>
<url><loc>https://www.goodingco.com/auction/geneva-auction-2027</loc></url>
<url><loc>https://www.goodingco.com/auction/amelia-island-auctions-2026</loc></url>
<url><loc>https://www.goodingco.com/lot/1966-porsche-911</loc></url>
</urlset>`;

const vehicle = (title, year, make, model = "x") => ({ __typename: "ContentfulVehicle", title, modelYear: year, make: { name: make }, model, cloudinaryImagesCombined: [{ public_id: "Prod/FL26 Amelia/449 Car/a_1" }] });
const auctionPage = (lots, { currency = "USD", end = "2026-03-06T17:00-05:00" } = {}) => ({
  result: { data: { contentfulWebPageAuction: { auction: { currency, subEvents: [{ __typename: "ContentfulSubEventViewing" }, { __typename: "ContentfulSubEventAuction", startDate: "2026-03-05T11:00-05:00", endDate: "2026-03-05T17:00-05:00" }, { __typename: "ContentfulSubEventAuction", startDate: "2026-03-06T11:00-05:00", endDate: end }], lot: lots } } } },
});
const lotNode = (extra = {}) => ({ result: { data: { contentfulLot: { lowEstimate: 100000, highEstimate: 150000, auction: { currency: "USD" }, item: { chassis: "1234567890ABCDEFG", highlights: ["Finished in Guards Red", "12,345 Miles from New", "Five-Speed Manual Gearbox"], specifications: ["3.2-Liter Flat-6 Engine"] }, ...extra } } } });

const response = body => ({ ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body });
const notFound = { ok: false, status: 404, text: async () => "" };

const fetchFrom = routes => async (url) => {
  const key = Object.keys(routes).find(route => url.endsWith(route));
  return key ? response(routes[key]) : notFound;
};

test("sitemap gives result pages and auction pages separately (future auctions have both)", () => {
  const { realized, auctions } = GoodingScraper.parseSitemap(sitemap);
  assert.deepEqual(realized.sort(), ["amelia-island-auctions-2026", "geared-online-motorcycles", "geneva-auction-2027"]);
  assert.deepEqual(auctions.sort(), ["amelia-island-auctions-2026", "geneva-auction-2027"]);
});

test("titles lose the sale tag, and the model stops at body words as for the other sources", () => {
  assert.equal(GoodingScraper.cleanTitle("1966 Porsche 911 (FL26)"), "1966 Porsche 911");
  assert.equal(GoodingScraper.cleanTitle("1955 Mercedes-Benz 300 SL Gullwing"), "1955 Mercedes-Benz 300 SL Gullwing");
});

test("updateSoldArchive keeps sold cars with a price, skips unsold, motorcycles and future auctions, and converts the price at the sale date", async () => {
  const dataDir = tmpDir();
  const scraper = new GoodingScraper({
    dataDir,
    fx: fakeFx,
    log: () => {},
    sleep: async () => {},
    now: () => Date.parse("2026-10-04T12:00:00Z"),
    fetchImpl: fetchFrom({
      "/sitemap.xml": sitemap,
      "/auction/realized/amelia-island-auctions-2026/page-data.json": auctionPage([
        { slug: "1966-porsche-911", salePrice: 140000, lotNumber: 2, item: vehicle("1966 Porsche 911 (FL26)", 1966, "Porsche") },
        { slug: "1913-silver-ghost", salePrice: null, lotNumber: 50, item: vehicle("1913 Rolls-Royce Silver Ghost", 1913, "Rolls-Royce") },
        { slug: "poster", salePrice: 500, lotNumber: 9, item: { __typename: "ContentfulAutomobilia", title: "Poster" } },
        { slug: "1999-ducati-916", salePrice: 30000, lotNumber: 10, item: vehicle("1999 Ducati 916", 1999, "Ducati ") },
        { slug: "1970-citroen-sm", salePrice: 80000, lotNumber: 11, item: vehicle("1970 Citroen SM", 1970, "Citroen") },
      ]),
      "/auction/realized/geneva-auction-2027/page-data.json": auctionPage([{ slug: "future-car", salePrice: 90000, lotNumber: 1, item: vehicle("2027 Future", 2027, "Ferrari") }], { currency: "EUR", end: "2027-02-06T20:00+01:00" }),
    }),
  });

  assert.equal(await scraper.updateSoldArchive(), 2); // «Porsche» и «Citroën»; мотоцикл, снятый лот, автомобилия и будущие торги не берём

  assert.equal(scraper.readSold().find(item => item.id === "gooding-1970-citroen-sm").make, "Citroën");
  const lot = scraper.readSold().find(item => item.id === "gooding-1966-porsche-911");
  assert.equal(lot.id, "gooding-1966-porsche-911");
  assert.equal(lot.title, "1966 Porsche 911");
  assert.equal(lot.make, "Porsche");
  assert.equal(lot.year, 1966);
  assert.equal(lot.source, "Gooding & Company");
  assert.equal(lot.sourceUrl, "https://www.goodingco.com/lot/1966-porsche-911");
  assert.equal(lot.salePrice, 140000);
  assert.equal(lot.salePriceLocal, 140000);
  assert.equal(lot.soldAt, "2026-03-06T00:00:00.000Z");
  assert.equal(lot.sold, true);
  assert.equal(lot.photoUrl, "https://media.goodingco.com/image/upload/c_fill,g_auto,q_88,w_600/v1/Prod/FL26%20Amelia/449%20Car/a_1");

  // повторный заход: аукцион уже закрыт, новых лотов нет
  assert.equal(await scraper.updateSoldArchive(), 0);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a euro auction is stored in euro and converted to dollars", async () => {
  const dataDir = tmpDir();
  const scraper = new GoodingScraper({
    dataDir, fx: fakeFx, log: () => {}, sleep: async () => {}, now: () => Date.parse("2026-10-04T12:00:00Z"),
    fetchImpl: fetchFrom({
      "/sitemap.xml": "<urlset><url><loc>https://www.goodingco.com/auction/realized/paris-2026</loc></url></urlset>",
      "/auction/realized/paris-2026/page-data.json": auctionPage([{ slug: "1970-citroen-sm", salePrice: 100000, lotNumber: 1, item: vehicle("1970 Citroën SM", 1970, "Citroën") }], { currency: "EUR", end: "2026-02-04T20:00+01:00" }),
    }),
  });
  await scraper.updateSoldArchive();
  const lot = scraper.readSold()[0];
  assert.equal(lot.currency, "EUR");
  assert.equal(lot.salePriceLocal, 100000);
  assert.equal(lot.salePrice, 110000);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a lot page gives the VIN or chassis number, mileage, colour and gearbox, and enrichment marks the lot as checked", async () => {
  const dataDir = tmpDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "sold.json"), JSON.stringify({
    "gooding-1966-porsche-911": { id: "gooding-1966-porsche-911", title: "1966 Porsche 911", make: "Porsche", year: 1966, source: "Gooding & Company", sourceUrl: "https://www.goodingco.com/lot/1966-porsche-911", salePrice: 140000, soldAt: "2026-03-06T00:00:00.000Z", sold: true, conditionFacts: [] },
  }));
  const scraper = new GoodingScraper({
    dataDir, fx: fakeFx, log: () => {}, sleep: async () => {},
    fetchImpl: fetchFrom({ "/page-data/lot/1966-porsche-911/page-data.json": lotNode() }),
  });
  await scraper.enrichSoldFromPages({ delayMs: 0 });
  const lot = scraper.readSold()[0];
  assert.equal(lot.vin, "1234567890ABCDEFG");
  assert.equal(lot.mileage, 12345);
  assert.equal(lot.transmissionKind, "manual");
  assert.ok(lot.pageCheckedAt);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("an old chassis number that is not a VIN is stored as chassis", () => {
  const patch = GoodingScraper.parseGoodingLotPage(JSON.stringify(lotNode({ item: { chassis: "2420E", highlights: ["Original Coachwork"] } })), { title: "1913 Rolls-Royce Silver Ghost" });
  assert.equal(patch.chassis, "2420E");
  assert.equal(patch.vin, undefined);
});

test("run() lists upcoming auction lots with a USD estimate and the auction end as closing time", async () => {
  const dataDir = tmpDir();
  const scraper = new GoodingScraper({
    dataDir, fx: fakeFx, log: () => {}, sleep: async () => {}, now: () => Date.parse("2026-10-04T12:00:00Z"),
    fetchImpl: fetchFrom({
      "/sitemap.xml": "<urlset><url><loc>https://www.goodingco.com/auction/geneva-auction-2026</loc></url><url><loc>https://www.goodingco.com/auction/realized/geneva-auction-2026</loc></url><url><loc>https://www.goodingco.com/auction/old-auction-2020</loc></url></urlset>",
      "/page-data/auction/geneva-auction-2026/page-data.json": {
        result: { data: { ...auctionPage([], { currency: "EUR", end: "2026-11-08T23:00+01:00" }).result.data, allContentfulLot: { edges: [{ node: { slug: "1962-300-sl", item: vehicle("1962 Mercedes-Benz 300 SL Roadster", 1962, "Mercedes-Benz") } }] } } },
      },
      "/page-data/lot/1962-300-sl/page-data.json": lotNode({ lowEstimate: 1000000, highEstimate: 1500000, auction: { currency: "EUR" } }),
    }),
  });

  const lots = await scraper.run();
  assert.equal(lots.length, 1);
  assert.equal(lots[0].id, "gooding-1962-300-sl");
  assert.equal(lots[0].make, "Mercedes-Benz");
  assert.equal(lots[0].closesAt, "2026-11-08T22:00:00.000Z");
  assert.equal(lots[0].status, "open");
  assert.equal(lots[0].estimateMin, 1100000);
  assert.equal(lots[0].estimateMax, 1650000);
  assert.equal(scraper.readStatus().ok, true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
