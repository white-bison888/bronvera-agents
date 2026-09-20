const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const originalCwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bronvera-worker-'));
process.chdir(temp);
const Worker = require('../src/photos/worker');
const queue = require('../src/photos/queue');
const { calculateMaxBid } = require('../src/economics/max-bid');
after(() => { process.chdir(originalCwd); fs.rmSync(temp, { recursive: true, force: true }); });

test('failed assessment survives restart and succeeds on retry', async () => {
  queue.enqueue([{ lotNumber: '123' }]);
  let assessment = { available: false, reason: 'Temporary API failure' };
  const dependencies = {
    bidCars: { findByLotNumber: () => ({ url: 'https://example.com/lot', seller: 'State Farm Group Insurance' }) },
    photoCollector: { collect: async () => ({ '123': ['photo.jpg'] }) },
    photoAssessor: { assess: async () => [assessment] },
  };
  const worker = new Worker(dependencies);
  await worker.tick();
  assert.equal(queue.stats().pending, 1);
  assert.equal(queue.stats().items[0].attempts, 1);
  assert.match(queue.stats().items[0].lastError, /Temporary API failure/);
  assert.equal(worker.lastResult, null);
  assert.equal(queue.nextPending(), null);
  const state = JSON.parse(fs.readFileSync(queue.QUEUE_FILE, 'utf8'));
  state.items[0].lastAttemptAt = '2000-01-01T00:00:00Z';
  fs.writeFileSync(queue.QUEUE_FILE, JSON.stringify(state));
  assessment = { available: true, repairCostMin: 1000, repairCostMax: 2000 };
  const restarted = new Worker(dependencies);
  await restarted.tick();
  assert.equal(queue.stats().pending, 0);
  assert.equal(restarted.lastResult.lotNumber, '123');
});

test('history write failure retains task for retry', async () => {
  queue.clear();
  queue.enqueue([{ lotNumber: '123' }]);
  const worker = new Worker({
    bidCars: { findByLotNumber: () => ({ url: 'https://example.com/lot', seller: 'State Farm Group Insurance' }) },
    photoCollector: { collect: async () => ({ '123': ['photo.jpg'] }) },
    photoAssessor: { assess: async () => [{ available: true, repairCostMax: 2000 }] },
  });
  worker.refreshHistory = () => { throw new Error('Disk full'); };
  await worker.tick();
  assert.equal(queue.stats().pending, 1);
  assert.equal(queue.stats().items[0].lastError, 'Disk full');
  assert.equal(worker.lastResult, null);
});

test('missing or failed photos cannot produce a bid', () => {
  for (const photoAssessment of [undefined, { available: false, repairCostMax: 100 }]) {
    const result = calculateMaxBid({ marketValueUsd: 30000, photoAssessment });
    assert.equal(result.maxBidUsd, null);
    assert.equal(result.verdict, 'PENDING_PHOTOS');
  }
});

test('usable photos do not replace missing market evidence', () => {
  const result = calculateMaxBid({ photoAssessment: { available: true, repairCostMax: 2000 } });
  assert.equal(result.maxBidUsd, null);
  assert.equal(result.verdict, 'NEEDS_MARKET_DATA');
  assert.equal(result.photoStatus, 'ok');
});

test('five failures stop automatic retries; explicit enqueue restarts them', () => {
  queue.clear();
  queue.enqueue([{ lotNumber: '456' }]);
  for (let i = 0; i < 5; i++) queue.markFailed('456', 'Unavailable');
  assert.equal(queue.stats().failed, 1);
  assert.equal(queue.stats().pending, 0);
  assert.equal(queue.nextPending(), null);
  assert.equal(queue.enqueue([{ lotNumber: '456' }]), 1);
  assert.equal(queue.stats().failed, 0);
  assert.equal(queue.nextPending().lotNumber, '456');
});

test('corrupt queue cannot be silently overwritten', () => {
  fs.writeFileSync(queue.QUEUE_FILE, '{broken');
  assert.throws(() => queue.enqueue([{ lotNumber: '789' }]));
  assert.equal(fs.readFileSync(queue.QUEUE_FILE, 'utf8'), '{broken');
  fs.writeFileSync(queue.QUEUE_FILE, '{"items":[]}');
});

test('usage records cost, duration and failure without storing response text', async () => {
  const { measuredCall, estimateCost } = require('../src/observability/usage');
  assert.equal(estimateCost('unknown', { input_tokens: 1, output_tokens: 1 }), null);
  assert.equal(estimateCost('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 100 }), 0.0045);
  await measuredCall({ component: 'test', model: 'claude-sonnet-4-6' }, async () => ({
    usage: { input_tokens: 1000, output_tokens: 100 }, content: 'private-response',
  }));
  await assert.rejects(measuredCall({ component: 'test' }, async () => { throw new Error('secret'); }));
  const raw = fs.readFileSync(path.join(temp, 'data', 'usage.jsonl'), 'utf8');
  assert.ok(!raw.includes('private-response') && !raw.includes('secret'));
  const events = raw.trim().split('\n').map(JSON.parse);
  assert.equal(events[0].costUsd, 0.0045);
  assert.ok(events[0].durationMs >= 0);
  assert.equal(events[1].status, 'error');
  assert.equal(events[1].costUsd, null);
});

test('successful assessment updates history before completing task', async () => {
  const history = require('../src/history/store');
  queue.clear();
  queue.enqueue([{ lotNumber: '999' }]);
  history.appendRun([{ lotNumber: '999', marketValueUsd: 40000, decision: 'PENDING_PHOTOS', decisionHeld: 'WATCH' }]);
  const worker = new Worker({
    bidCars: { findByLotNumber: () => ({ url: 'https://example.com/lot', seller: 'State Farm Group Insurance' }) },
    photoCollector: { collect: async () => ({ '999': ['photo.jpg'] }) },
    photoAssessor: { assess: async () => [{ available: true, repairCostMin: 1000, repairCostMax: 2000 }] },
  });
  await worker.tick();
  const entries = history.readAll();
  assert.equal(entries.length, 2);
  assert.equal(entries[1].repairCostSource, 'photo');
  assert.ok(Number.isFinite(entries[1].maxBidUsd));
  assert.equal(entries[1].decision, 'WATCH');
  assert.equal(queue.stats().pending, 0);
});

test('parallel calls share a run; unknown costs are not reported as zero', async () => {
  const { measureRun, measuredCall } = require('../src/observability/usage');
  await measureRun('test-run', async () => {
    await Promise.all([
      measuredCall({ model: 'claude-sonnet-4-6' }, async () => ({ usage: { input_tokens: 1000, output_tokens: 100 } })),
      measureRun('nested', () => measuredCall({ model: 'unknown' }, async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }))),
    ]);
  });
  const events = fs.readFileSync(path.join(temp, 'data', 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const summary = events.find(x => x.event === 'run' && x.component === 'test-run');
  assert.equal(summary.calls, 2);
  assert.equal(summary.knownCostUsd, 0.0045);
  assert.equal(summary.unpricedCalls, 1);
  assert.equal(summary.costUsd, null);
  assert.equal(events.filter(x => x.runId === summary.runId && x.callId).length, 2);
  assert.equal(events.filter(x => x.component === 'nested').length, 0);
});

test('with photos already on disk an unknown seller still sends the collector to the lot page, and a non-insurer is skipped', async () => {
  const history = require('../src/history/store');
  queue.clear();
  queue.enqueue([{ lotNumber: '1-675' }]);
  history.appendRun([{ lotNumber: '1-675', marketValueUsd: 27000, decision: 'BUY', maxBidUsd: 13030, screener: { day: '2026-09-15' } }]);

  const calls = [];
  const worker = new Worker({
    bidCars: { findByLotNumber: () => ({ url: 'https://example.com/lot', seller: '---' }) },
    photoCollector: {
      collect: async (lots, options) => { calls.push(options); return { '1-675': ['1.jpg'] }; },
      takeDetails: () => ({ '1-675': { seller: 'Non-insurance Company' } }),
      readPhotoDir: () => ['1.jpg'],
    },
    photoAssessor: { assess: async () => { throw new Error('assessment must not run for a non-insurer'); } },
  });

  await worker.tick();

  assert.deepEqual(calls, [{ refill: true }]);
  assert.equal(queue.stats().pending, 0);
  const latest = history.readAll().filter(entry => entry.lotNumber === '1-675').pop();
  assert.equal(latest.decision, 'SKIP');
  assert.equal(latest.maxBidUsd, null);
  assert.equal(latest.screener.day, '2026-09-15');
  assert.equal(latest.lotDetails.seller, 'Non-insurance Company');

  // Продавец уже известен — страницу лота ради него не открываем.
  queue.enqueue([{ lotNumber: '0-777' }]);
  const known = [];
  await new Worker({
    bidCars: { findByLotNumber: () => ({ url: 'https://example.com/lot', seller: 'State Farm Group Insurance' }) },
    photoCollector: { collect: async (lots, options) => { known.push(options); return { '0-777': [] }; }, readPhotoDir: () => ['1.jpg'] },
    photoAssessor: { assess: async () => [{ available: true, repairCostMin: 1000, repairCostMax: 2000 }] },
  }).tick();
  assert.deepEqual(known, [{ refill: false }]);
});

test('photos without a seller do not finish the task: the collector comes back for the seller', async () => {
  queue.clear();

  const worker = new Worker({
    bidCars: { findByLotNumber: () => ({ url: 'https://example.com/lot', seller: '---' }) },
    photoCollector: {
      collect: async () => ({ '1-777': ['photo.jpg'] }),
      // Страница отдала снимки, но продавца не показала.
      takeDetails: () => ({ '1-777': { keyPresence: 'Present' } }),
    },
    photoAssessor: { assess: async () => [{ available: true, repairCostMin: 1000, repairCostMax: 2000, severity: 'moderate' }] },
  });

  queue.enqueue([{ lotNumber: '1-777' }], 'run-seller');
  await worker.tick();

  const item = queue.read().items.find(entry => entry.lotNumber === '1-777');

  assert.ok(item, 'лот остался в очереди');
  assert.equal(item.attempts, 1);
  assert.match(item.lastError, /Продавец не прочитан/);

  // Разбор снимков при этом не повторится: он уже в кэше оценок.
})
