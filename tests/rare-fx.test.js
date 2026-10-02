const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FxRates, reconvertArchive } = require("../src/rare/fx");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bronvera-fx-")), "fx-rates.json");

// Ответ как у api.frankfurter.dev: единиц валюты за 1 USD, дата — фактический рабочий день.
const dayResponse = (date, rates) => ({ ok: true, status: 200, json: async () => ({ amount: 1, base: "USD", date, rates }) });

test("usdPerUnit returns the rate for the sale date, not today's, and reports the actual rate day", async () => {
  const calls = [];
  const fx = new FxRates({
    file: tmpFile(),
    fetchImpl: async (url) => { calls.push(url); return dayResponse("2005-03-11", { GBP: 0.5, EUR: 0.8, AUD: 1.25, NZD: 1.3, CHF: 1.2 }); },
  });

  const { rate, rateDate } = await fx.usdPerUnit("GBP", "2005-03-12"); // суббота
  assert.equal(rate, 2); // 1 / 0.5
  assert.equal(rateDate, "2005-03-11"); // сервис отдал пятницу — показываем её
  assert.match(calls[0], /\/v1\/2005-03-12\?base=USD/);
});

test("rates are cached per date: the same day is fetched once, USD never hits the network", async () => {
  const file = tmpFile();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return dayResponse("2010-06-01", { GBP: 0.5, EUR: 0.8, AUD: 1.25, NZD: 1.3, CHF: 1.2 }); };
  const fx = new FxRates({ file, fetchImpl });

  await fx.usdPerUnit("GBP", "2010-06-01");
  await fx.usdPerUnit("EUR", "2010-06-01");
  assert.equal(calls, 1);

  assert.deepEqual(await fx.usdPerUnit("USD", "1990-01-01"), { rate: 1, rateDate: "1990-01-01" });
  assert.equal(calls, 1);

  // новый экземпляр читает кэш из файла — в сеть не ходит
  const again = new FxRates({ file, fetchImpl });
  await again.usdPerUnit("GBP", "2010-06-01");
  assert.equal(calls, 1);
});

test("convert prices an amount by the UTC date of the sale", async () => {
  const fx = new FxRates({
    file: tmpFile(),
    fetchImpl: async (url) => dayResponse(String(url).match(/v1\/(\d{4}-\d{2}-\d{2})/)[1], { GBP: 0.5, EUR: 0.8, AUD: 1.25, NZD: 1.3, CHF: 1.2 }),
  });

  assert.deepEqual(await fx.convert(1000, "GBP", "2020-05-05T23:30:00.000Z"), { salePrice: 2000, fxRate: 2, fxDate: "2020-05-05" });
});

test("a date newer than the latest published rate falls back to the latest one", async () => {
  const urls = [];
  const fx = new FxRates({
    file: tmpFile(),
    now: () => Date.parse("2026-10-02T08:00:00Z"),
    fetchImpl: async (url) => {
      urls.push(String(url));
      return String(url).includes("/latest") ? dayResponse("2026-10-01", { GBP: 0.8, EUR: 0.9, AUD: 1.4, NZD: 1.7, CHF: 0.8 }) : { ok: false, status: 404 };
    },
  });

  const { rateDate } = await fx.usdPerUnit("GBP", "2026-10-02");
  assert.equal(rateDate, "2026-10-01");
  assert.equal(urls.length, 2);
});

test("an unavailable rate throws instead of guessing", async () => {
  const fx = new FxRates({ file: tmpFile(), fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(() => fx.usdPerUnit("GBP", "2015-01-01"), /курс на 2015-01-01 не получен/);
});

test("reconvertArchive re-prices only non-USD lots that have no rate date yet and leaves failures for later", async () => {
  const fx = { convert: async (amount, currency, soldAt) => { if (soldAt.startsWith("2001")) throw new Error("нет данных"); return { salePrice: amount * 2, fxRate: 2, fxDate: soldAt.slice(0, 10) }; } };
  const archive = {
    a: { id: "a", currency: "GBP", salePriceLocal: 10, salePrice: 1, soldAt: "2020-01-01T00:00:00.000Z" },
    done: { id: "done", currency: "GBP", salePriceLocal: 10, salePrice: 99, fxDate: "2020-01-01", soldAt: "2020-01-01T00:00:00.000Z" },
    usd: { id: "usd", currency: "USD", salePriceLocal: 10, salePrice: 10, soldAt: "2020-01-01T00:00:00.000Z" },
    old: { id: "old", currency: "EUR", salePriceLocal: 10, salePrice: 5, soldAt: "2001-01-01T00:00:00.000Z" },
  };

  assert.equal(await reconvertArchive(archive, fx), 1);
  assert.equal(archive.a.salePrice, 20);
  assert.equal(archive.done.salePrice, 99);
  assert.equal(archive.usd.salePrice, 10);
  assert.equal(archive.old.salePrice, 5);
  assert.equal(archive.old.fxDate, undefined);
});
