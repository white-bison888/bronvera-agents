const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeRun } = require('../src/searches/summary');

const run = extra => ({ id: 'r1', status: 'succeeded', elapsed_time: 21.5, created_at: '2026-09-15 18:43:30.457647', inputs: JSON.stringify({ user_request: 'Tesla 100D, P100D, Plaid до $10000' }), ...extra });

test('a search that found lots counts them by verdict', () => {
  const summary = summarizeRun(run({
    outputs: JSON.stringify({
      ORCHESTRATOR: '<think></think>{"recommendations":[]}',
      max_bid: JSON.stringify({ success: true, results: [{ lotNumber: 'A', verdict: 'BUY' }, { lotNumber: 'B', verdict: 'SKIP' }, { lotNumber: 'C', verdict: 'SKIP' }] }),
    }),
  }));

  assert.equal(summary.query, 'Tesla 100D, P100D, Plaid до $10000');
  assert.equal(summary.createdAt, '2026-09-15T18:43:30.457647Z');
  assert.equal(summary.outcome, 'found');
  assert.equal(summary.count, 3);
  assert.deepEqual(summary.verdicts, { BUY: 1, SKIP: 2 });
});

test('no matches, a failed run and a clarification are told apart', () => {
  assert.equal(summarizeRun(run({ outputs: JSON.stringify({ message: 'совпадений нет' }) })).outcome, 'none');
  assert.equal(summarizeRun(run({ status: 'failed', outputs: null, error: 'Node ASSESSOR failed' })).message, 'Node ASSESSOR failed');
  assert.equal(summarizeRun(run({ status: 'running', outputs: null })).outcome, 'running');

  const clarify = summarizeRun(run({ outputs: JSON.stringify({ clarification: '```json\n{"summary":"Уточните модель","reasons":[]}\n```' }) }));
  assert.equal(clarify.outcome, 'clarify');
  assert.equal(clarify.message, 'Уточните модель');
});
