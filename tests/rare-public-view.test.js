const { test } = require("node:test");
const assert = require("node:assert/strict");

const { publicLot, publicLots, publicTitle, yearFromTitle } = require("../src/rare/public-view");

test("наружу не уходят адрес фото и заголовок площадки", () => {
  const lot = publicLot({
    id: "bat-1",
    title: "Oslo Blue 1972 Porsche 911S Targa 5-Speed",
    make: "Porsche",
    model: "911S Targa",
    year: 1972,
    photoUrl: "https://example.com/a.jpg",
    salePrice: 100000,
  });

  assert.equal("photoUrl" in lot, false);
  assert.equal(lot.title, "1972 Porsche 911S Targa");
  assert.equal(lot.salePrice, 100000);
  assert.equal(lot.id, "bat-1");
});

test("у активного лота год берётся из заголовка площадки и отдаётся полем", () => {
  const lot = publicLot({ id: "bat-2", title: "37k-Mile 1969 Chevrolet K5 Blazer 4×4 3-Speed", make: "Chevrolet", model: "K5 Blazer", photoUrl: null });

  assert.equal(lot.year, 1969);
  assert.equal(lot.title, "1969 Chevrolet K5 Blazer");
});

test("комплектация добавляется, если её нет в модели", () => {
  assert.equal(publicTitle({ year: 2019, make: "Porsche", model: "911", trimName: "GT3 RS" }), "2019 Porsche 911 GT3 RS");
  assert.equal(publicTitle({ year: 2019, make: "Porsche", model: "911 GT3 RS", trimName: "GT3 RS" }), "2019 Porsche 911 GT3 RS");
});

test("без модели и года остаётся марка, без всего — «Лот»", () => {
  assert.equal(publicLot({ title: "Porsche Dealership Sign", make: "Porsche", model: null }).title, "Porsche");
  assert.equal(publicLot({ title: "", make: "", model: null }).title, "Лот");
});

test("исходная запись не меняется, список и пустые значения проходят", () => {
  const source = { id: "x", title: "1990 BMW M3", make: "BMW", model: "M3", photoUrl: "u" };
  const [out] = publicLots([source]);

  assert.equal(source.title, "1990 BMW M3");
  assert.equal(source.photoUrl, "u");
  assert.equal(out.title, "1990 BMW M3");
  assert.equal(publicLot(null), null);
  assert.equal(yearFromTitle("No year here"), null);
});
