const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const originalCwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-costs-'));
process.chdir(temp);

const prices = require('../src/costs/prices');
const ledger = require('../src/costs/ledger');
const { createDifyUsage } = require('../src/costs/dify-usage');
const { buildPeriodSummary, buildRunCost, periodBounds } = require('../src/costs/report');

after(() => { process.chdir(originalCwd); fs.rmSync(temp, { recursive: true, force: true }); });

// Узлы прогона Dify 15.09 (efe87b86…), сокращённо.
const usage = (prompt, completion, total) => ({ prompt_tokens: prompt, completion_tokens: completion, total_price: String(total) });
const difyRun = {
  run: { id: 'efe87b86-7d60-4c27-b057-a8b47b6d7087', status: 'succeeded', elapsed_time: 290.889, created_at: '2026-09-15T08:31:47.582443' },
  nodes: [
    { title: 'SEARCH PARSER', status: 'succeeded', model: 'claude-opus-5', usage: usage(2635, 25, 0.0138) },
    { title: 'ORCHESTRATOR', status: 'succeeded', model: 'claude-opus-5', usage: usage(26662, 6212, 0.28861) },
  ],
};

test('search cost adds Dify steps, proxy traffic, photo tokens and a time share of the server', () => {
  const entries = [
    { kind: 'proxy', source: 'фото лотов', bytes: 50 * 1024 ** 2, costUsd: ledger.proxyCostUsd(50 * 1024 ** 2) },
    { kind: 'vision', model: 'gemini-3.5-flash-lite', inputTokens: 20000, outputTokens: 1000, tier: 'free', costUsd: 0, paidEquivalentUsd: 0.0085, priceKnown: true, usageReported: true },
  ];

  const report = buildRunCost({ runId: difyRun.run.id, dify: difyRun, entries, pendingPhotos: 2 });

  const step = title => report.items.find(item => item.label === title);
  assert.equal(step('SEARCH PARSER').costUsd, 0.0138);
  assert.equal(step('ORCHESTRATOR').costUsd, 0.28861);
  assert.match(step('ORCHESTRATOR').detail, /26 662 вход \/ 6 212 выход/);

  const proxy = report.items.find(item => item.group === 'Прокси');
  assert.equal(proxy.costUsd, 0.048828);

  const vision = report.items.find(item => item.group === 'Разбор фото');
  assert.equal(vision.costUsd, 0);
  assert.match(vision.detail, /бесплатный тариф \(на платном \$0,0085\)/);

  // Сервер: $23,09 в месяц × 291 с из 30 дней.
  const server = report.items.find(item => item.label.startsWith('Сервер Hetzner'));
  assert.equal(prices.eurUsd.rate, 1.1551);
  assert.equal(server.costUsd, 0.002591);
  assert.match(server.detail, /доля за 4 мин 51 с из \$23,09 в месяц/);

  // Тариф Vercel не проверен — в сумму не входит, но назван.
  assert.deepEqual(report.unknown, ['Сайт на Vercel']);
  assert.equal(report.totalUsd, Math.round((0.0138 + 0.28861 + 0.048828 + server.costUsd) * 1e6) / 1e6);
  assert.equal(report.pendingPhotos, 2);
});

test('a new model without a price is flagged instead of counted as zero, and a Dify price drift is visible', () => {
  const report = buildRunCost({
    runId: 'x',
    dify: {
      run: difyRun.run,
      nodes: [
        { title: 'NEW STEP', status: 'succeeded', model: 'claude-fable-9', usage: usage(1000, 100, 0.02) },
        { title: 'SEARCH PARSER', status: 'succeeded', model: 'claude-opus-5', usage: usage(2635, 25, 0.05) },
        { title: 'ORCHESTRATOR', status: 'failed', model: null, usage: null },
      ],
    },
  });

  assert.ok(report.unknown.includes('NEW STEP'));
  assert.equal(report.items.find(item => item.label === 'NEW STEP').costUsd, null);
  assert.match(report.items.find(item => item.label === 'SEARCH PARSER').detail, /Dify насчитал \$0,05 — сверить прайс/);
  assert.match(report.items.find(item => item.label === 'ORCHESTRATOR').detail, /упал до ответа модели/);

  const blind = buildRunCost({ runId: 'x', dify: null });
  assert.ok(blind.unknown.includes('Шаги ИИ'));
});

test('day and month bounds follow Minsk time', () => {
  assert.deepEqual(
    [periodBounds('day', '2026-09-15').from, periodBounds('day', '2026-09-15').to],
    ['2026-09-14T21:00:00.000Z', '2026-09-15T21:00:00.000Z'],
  );
  const month = periodBounds('month', '2026-09-15');
  assert.deepEqual([month.from, month.to, month.days], ['2026-08-31T21:00:00.000Z', '2026-09-30T21:00:00.000Z', 30]);
});

test('period totals separate searches, the morning screener and bid watching; fixed bills are a daily share', () => {
  const summary = buildPeriodSummary({
    period: periodBounds('day', '2026-09-15'),
    dify: { runs: [{ id: 'a' }, { id: 'b' }], nodes: [...difyRun.nodes, difyRun.nodes[0]] },
    entries: [
      { kind: 'proxy', runId: 'efe87b86', source: 'каталог bid.cars', bytes: 1024 ** 2, costUsd: 0.001 },
      { kind: 'proxy', runId: 'screener-2026-09-15', source: 'выдача bid.cars', bytes: 1024 ** 2, costUsd: 0.002 },
      { kind: 'proxy', runId: 'bid-watcher', source: 'слежение за ставками', bytes: 1024 ** 2, costUsd: 0.003 },
    ],
  });

  const labels = summary.items.map(item => item.label);
  assert.ok(labels.includes('Трафик bid.cars через DataImpulse — Поиски'));
  assert.ok(labels.includes('Трафик bid.cars через DataImpulse — Утренний отбор'));
  assert.ok(labels.includes('Трафик bid.cars через DataImpulse — Слежение за ставками'));

  const llm = summary.items[0];
  assert.equal(llm.costUsd, 0.31621);
  assert.equal(llm.steps.find(step => step.label === 'SEARCH PARSER').runs, 2);
  assert.equal(summary.searches, 2);

  const server = summary.items.find(item => item.label.startsWith('Сервер Hetzner'));
  assert.equal(server.costUsd, 0.769682);
  assert.match(server.detail, /÷ 30 дн\./);
});

test('ledger records the run from context, prices photo tokens by model version and meters proxy bytes', async () => {
  await ledger.withRun('run-1', async () => {
    ledger.recordVision({ lotNumber: '0-1', provider: 'gemini', model: 'gemini-3.5-flash-lite-preview-09-2026', usage: { inputTokens: 1000000, outputTokens: 100000 } });

    const context = new EventEmitter();
    const meter = ledger.meterBrowserContext(context, { source: 'фото лотов', viaProxy: true });
    const request = size => ({ sizes: async () => ({ requestHeadersSize: 0, requestBodySize: 0, responseHeadersSize: 0, responseBodySize: size }) });

    context.emit('requestfinished', request(512 * 1024 ** 2));
    context.emit('requestfinished', { sizes: async () => { throw new Error('gone'); } });

    const result = await meter.finish();
    assert.equal(result.costUsd, 0.5);
  });

  ledger.recordVision({ lotNumber: '0-2', model: 'unknown-vision', usage: null });

  const [vision, proxy] = ledger.readEntries({ runId: 'run-1' });
  assert.equal(vision.paidEquivalentUsd, 0.55);
  assert.equal(vision.costUsd, 0);
  assert.equal(proxy.bytes, 512 * 1024 ** 2);
  assert.equal(proxy.requests, 2);

  const orphan = ledger.readEntries().find(entry => entry.lotNumber === '0-2');
  assert.equal(orphan.runId, null);
  assert.equal(orphan.usageReported, false);
});

test('Dify usage reader only accepts a UUID run and ISO period bounds', async () => {
  const seen = [];
  const dify = createDifyUsage({ query: async (sql) => { seen.push(sql); return '{"run":null,"nodes":[]}'; } });

  await assert.rejects(dify.run("x'; drop table workflow_runs; --"), /UUID/);
  await dify.run('efe87b86-7d60-4c27-b057-a8b47b6d7087');
  assert.match(seen[0], /workflow_run_id = 'efe87b86-7d60-4c27-b057-a8b47b6d7087'/);

  await assert.rejects(dify.period('2026-09-15', 'now'), /ISO/);
});
