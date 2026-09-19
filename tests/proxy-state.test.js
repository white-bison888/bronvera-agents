const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const proxyState = require('../src/providers/proxy-state');

// Поддельный прокси: отвечает на CONNECT так же, как настоящий.
const fakeProxy = answer => new Promise((resolve) => {
  const server = http.createServer();

  server.on('connect', (request, socket) => socket.end(answer));
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const servers = [];

after(() => servers.forEach(server => server.close()));

const use = async (answer) => {
  const server = await fakeProxy(answer);

  servers.push(server);
  process.env.PROXY_SERVER = `http://127.0.0.1:${server.address().port}`;
  delete process.env.PROXY_USERNAME;
  delete process.env.PROXY_PASSWORD;
};

test('the real reason comes from the proxy, not from the Chromium error', async () => {
  await use('HTTP/1.1 407 TRAFFIC_EXHAUSTED\r\n\r\n');

  const probe = await proxyState.probeProxy();
  assert.equal(probe.ok, false);
  assert.match(probe.reason, /407 TRAFFIC_EXHAUSTED/);

  // Заход Chromium сорвался по вине прокси: берём паузу.
  assert.equal(await proxyState.noteFailure(new Error('page.goto: net::ERR_PROXY_AUTH_UNSUPPORTED at https://bid.cars/…')), true);
  assert.equal(proxyState.paused(), true);
  assert.equal(proxyState.status().ok, false);
  assert.match(proxyState.status().reason, /407/);
});

test('a page error is not a proxy outage', async () => {
  await use('HTTP/1.1 200 Connection established\r\n\r\n');
  proxyState.noteSuccess();

  assert.equal(await proxyState.noteFailure(new Error('page.goto: net::ERR_ABORTED')), false);
  assert.equal(proxyState.paused(), false);

  // Прокси жив, хотя Chromium ругался на прокси: паузы нет.
  assert.equal(await proxyState.noteFailure(new Error('net::ERR_PROXY_CONNECTION_FAILED')), false);
  assert.equal(proxyState.status().ok, true);
});

test('the site is told the state, and a fresh check is not repeated', async () => {
  await use('HTTP/1.1 407 TRAFFIC_EXHAUSTED\r\n\r\n');
  proxyState.noteSuccess();

  const status = await proxyState.refresh({ maxAgeMs: 0 });
  assert.equal(status.ok, false);
  assert.match(status.reason, /407/);
  assert.ok(status.since);

  await use('HTTP/1.1 200 Connection established\r\n\r\n');
  assert.equal((await proxyState.refresh({ maxAgeMs: 60000 })).ok, false, 'свежую проверку не повторяем');
  assert.equal((await proxyState.refresh({ maxAgeMs: 0 })).ok, true, 'прокси ожил — состояние обновилось');
});

test('an outage survives a server restart', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-proxy-'));
  process.env.PROXY_STATE_FILE = path.join(dir, 'proxy-state.json');

  await use('HTTP/1.1 407 TRAFFIC_EXHAUSTED\r\n\r\n');
  proxyState.noteSuccess();
  await proxyState.refresh({ maxAgeMs: 0 });

  const saved = JSON.parse(fs.readFileSync(process.env.PROXY_STATE_FILE, 'utf8'));
  assert.equal(saved.ok, false);
  assert.ok(saved.since);

  // Перезапуск: модуль читает файл заново.
  delete require.cache[require.resolve('../src/providers/proxy-state')];
  const restarted = require('../src/providers/proxy-state');
  assert.equal(restarted.status().ok, false);
  assert.equal(restarted.status().since, saved.since);

  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.PROXY_STATE_FILE;
})
