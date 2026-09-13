const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const runs = new AsyncLocalStorage();

async function measureRun(component, operation) {
  // Nested components share the enclosing run, including parallel calls.
  if (runs.getStore()) return operation();
  const state = { runId: randomUUID(), calls: 0, knownCostUsd: 0, unpricedCalls: 0 };
  const started = Date.now();
  return runs.run(state, async () => {
    let status = 'success';
    try { return await operation(); }
    catch (error) { status = 'error'; throw error; }
    finally {
      record({ event: 'run', component, ...state, status,
        durationMs: Date.now() - started,
        costUsd: state.unpricedCalls ? null : state.knownCostUsd,
        scope: 'local-model-calls-only' });
    }
  });
}

// Standard direct API prices, verified 2026-09-07:
// https://platform.claude.com/docs/en/about-claude/pricing
function estimateCost(model, usage) {
  const input = model === 'claude-sonnet-4-6' ? 3
    : ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'].includes(model) ? 1 : null;
  if (input === null || !usage || !Number.isFinite(usage.input_tokens)
      || !Number.isFinite(usage.output_tokens)) return null;
  const writes = usage.cache_creation_input_tokens || 0;
  const hourWrites = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  return (usage.input_tokens * input + usage.output_tokens * input * 5
    + (usage.cache_read_input_tokens || 0) * input * 0.1
    + (writes - hourWrites) * input * 1.25 + hourWrites * input * 2) / 1000000;
}

// No prompts, images, API keys, or response text are written to this ledger.
function record(event) {
  try {
    const file = path.join(process.cwd(), 'data', 'usage.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  } catch {
    console.error('Usage ledger could not be written');
  }
}

async function measuredCall(metadata, operation) {
  const started = Date.now();
  const callId = randomUUID();
  try {
    const response = await operation();
    const costUsd = estimateCost(response.model || metadata.model, response.usage);
    const run = runs.getStore();
    if (run) {
      run.calls++;
      if (costUsd === null) run.unpricedCalls++;
      else run.knownCostUsd += costUsd;
    }
    record({ ...metadata, runId: run?.runId || null, callId, status: 'success', durationMs: Date.now() - started,
      usage: response.usage || null, model: response.model || metadata.model,
      costUsd,
      pricingBasis: 'standard-direct-api-2026-09-07' });
    return response;
  } catch (error) {
    const run = runs.getStore();
    if (run) { run.calls++; run.unpricedCalls++; }
    record({ ...metadata, runId: run?.runId || null, callId, status: 'error', durationMs: Date.now() - started,
      usage: null, costUsd: null });
    throw error;
  }
}

module.exports = { measuredCall, measureRun, record, estimateCost };
