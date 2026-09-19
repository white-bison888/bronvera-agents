const fs = require("fs");
const http = require("http");
const path = require("path");

/*
 * СОСТОЯНИЕ РЕЗИДЕНТНОГО ПРОКСИ
 *
 * Через прокси идут все заходы на bid.cars: ставки, фотографии, каталог.
 * Цены Беларуси собираются напрямую, поэтому когда у прокси кончается
 * оплаченный трафик, снаружи ломается не всё сразу — сайт продолжает
 * отвечать по сохранённому реестру, а цикл «прогноз → торги → сверка»
 * тихо встаёт.
 *
 * Так и вышло 16.09.2026: 1500 одинаковых строк ERR_PROXY_AUTH_UNSUPPORTED
 * в логе и ни слова о причине. Chromium на ответ 407 без понятной ему схемы
 * авторизации отвечает именно так, а настоящую причину видно только при
 * прямом CONNECT: «407 TRAFFIC_EXHAUSTED».
 *
 * Поэтому здесь: узнаём настоящую причину одним дешёвым запросом, пишем её
 * в лог один раз, держим паузу вместо бесполезных заходов каждые 4 минуты
 * и отдаём состояние сайту.
 */

// Ошибки Chromium, за которыми стоит прокси, а не страница.
const PROXY_ERRORS = /ERR_PROXY_AUTH_UNSUPPORTED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES/i;

const PAUSE_MS = 30 * 60 * 1000;

/*
 * Простой переживает перезапуск сервера: иначе на сайте «стоит с 20:50»
 * вместо «с 16.09», и трёхдневная тишина выглядит десятиминутной.
 */
const FILE = () => process.env.PROXY_STATE_FILE || path.join(process.cwd(), "data", "proxy-state.json");

const state = {
  ok: true,
  reason: null,
  since: null,
  checkedAt: null,
  pausedUntil: null,
  failures: 0,
};

try {
  const saved = JSON.parse(fs.readFileSync(FILE(), "utf8"));

  if (saved && saved.ok === false) {
    state.ok = false;
    state.reason = saved.reason || null;
    state.since = saved.since || null;
  }
} catch {
  // Файла нет — считаем, что всё работало.
}

const remember = () => {
  try {
    const file = FILE();

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ok: state.ok, reason: state.reason, since: state.since, checkedAt: state.checkedAt }, null, 2), "utf8");
  } catch {
    // Не записалось — состояние всё равно работает, просто не переживёт перезапуск.
  }
};

const isProxyError = error => PROXY_ERRORS.test(String(error?.message || error || ""));

/*
 * Живой ли прокси: CONNECT к bid.cars без загрузки страницы. Трафика это
 * почти не стоит, а ответ прокси («407 TRAFFIC_EXHAUSTED») говорит о причине
 * прямо, в отличие от ошибки Chromium.
 */
const probeProxy = ({ timeoutMs = 20000 } = {}) => new Promise((resolve) => {
  const server = String(process.env.PROXY_SERVER || "");

  if (!server)
    return resolve({ ok: true, reason: "прокси не настроен" });

  const [host, port] = server.replace(/^\w+:\/\//, "").split(":");
  const done = result => resolve(result);

  const answer = response => (response.statusCode >= 200 && response.statusCode < 300
    ? { ok: true, reason: null }
    : { ok: false, reason: `прокси отвечает ${response.statusCode} ${response.statusMessage || ""}`.trim() });

  const headers = { Host: "bid.cars:443" };

  if (process.env.PROXY_USERNAME) {
    const auth = `${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD || ""}`;
    headers["Proxy-Authorization"] = `Basic ${Buffer.from(auth).toString("base64")}`;
  }

  const request = http.request({
    host,
    port: Number(port) || 80,
    method: "CONNECT",
    path: "bid.cars:443",
    headers,
    timeout: timeoutMs,
  });

  /*
   * На CONNECT это событие приходит при любом ответе прокси, а не только
   * при успешном: «407 TRAFFIC_EXHAUSTED» тоже здесь. Поэтому смотрим код.
   */
  request.on("connect", (response, socket) => {
    socket.destroy();
    done(answer(response));
  });

  request.on("response", (response) => {
    response.resume();
    done(answer(response));
  });

  request.on("timeout", () => {
    request.destroy();
    done({ ok: false, reason: "прокси не отвечает" });
  });

  request.on("error", error => done({ ok: false, reason: `прокси недоступен: ${error.message}` }));
  request.end();
});

/*
 * Заход через прокси сорвался. Причину выясняем сами и говорим о ней один
 * раз: до конца паузы работа через прокси не запускается.
 */
const noteFailure = async (error, { where = "" } = {}) => {
  if (!isProxyError(error))
    return false;

  const probe = await probeProxy();

  if (probe.ok) {
    // Прокси жив: дело в самой странице, паузу не берём.
    state.checkedAt = new Date().toISOString();
    return false;
  }

  const first = state.ok;

  state.ok = false;
  state.reason = probe.reason;
  state.since = state.since || new Date().toISOString();
  state.checkedAt = new Date().toISOString();
  state.pausedUntil = new Date(Date.now() + PAUSE_MS).toISOString();
  state.failures += 1;

  remember();

  if (first) {
    console.error(
      `\n⛔ bid.cars недоступен: ${probe.reason}.` +
      `\n   Встают ставки, сбор фотографий и обновление реестра${where ? ` (сорвалось: ${where})` : ""}.` +
      `\n   Цены Беларуси идут напрямую и продолжают работать.` +
      `\n   Следующая проверка через ${Math.round(PAUSE_MS / 60000)} минут.\n`
    );
  }

  return true;
};

const noteSuccess = () => {
  const recovered = !state.ok;

  if (recovered)
    console.log("✅ bid.cars снова доступен через прокси");

  state.ok = true;
  state.reason = null;
  state.since = null;
  state.pausedUntil = null;
  state.failures = 0;
  state.checkedAt = new Date().toISOString();

  if (recovered)
    remember();
};

// Пауза после сорвавшегося захода: пока она держится, к bid.cars не ходим.
const paused = () => Boolean(state.pausedUntil && Date.now() < Date.parse(state.pausedUntil));

/*
 * Состояние для сайта. Сразу после перезапуска сервера прокси ещё никто не
 * трогал, поэтому раз в несколько минут проверяем его сами — дешёвым CONNECT,
 * без загрузки страниц.
 */
const refresh = async ({ maxAgeMs = 5 * 60 * 1000 } = {}) => {
  const fresh = state.checkedAt && Date.now() - Date.parse(state.checkedAt) < maxAgeMs;

  if (fresh)
    return status();

  const probe = await probeProxy();

  if (probe.ok) {
    noteSuccess();
  } else {
    const first = state.ok;

    state.ok = false;
    state.reason = probe.reason;
    state.since = state.since || new Date().toISOString();
    state.checkedAt = new Date().toISOString();

    remember();

    if (first)
      console.error(`⛔ bid.cars недоступен: ${probe.reason}. Ставки, фотографии и обновление реестра стоят.`);
  }

  return status();
};

const status = () => ({ ...state, paused: paused() });

module.exports = { isProxyError, probeProxy, noteFailure, noteSuccess, paused, refresh, status };
