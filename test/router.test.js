// Router: model resolution, capability filter, policy ordering, health-first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates } from '../src/router.js';

const providers = [
  { name: 'slow', baseUrl: 'http://a/v1', apiKey: null, keyless: true, models: ['big', 'shared'], capabilities: { tools: true, context: 128000 }, cost: 2, order: 0 },
  { name: 'fast', baseUrl: 'http://b/v1', apiKey: null, keyless: true, models: ['small', 'shared'], capabilities: { tools: false, context: 8000 }, cost: 1, order: 1 },
  { name: 'cheap', baseUrl: 'http://c/v1', apiKey: null, keyless: true, models: ['tiny'], capabilities: { tools: true, context: 4000 }, cost: 0, order: 2 },
];

const fresh = (latencyMs, ok = true) => ({ ok, latencyMs, ts: Date.now(), note: null });

test('"auto" returns every provider with a model, healthy first', () => {
  const health = new Map([
    ['slow', fresh(50)],
    ['fast', fresh(5)],
    ['cheap', fresh(800)],
  ]);
  const out = selectCandidates({ providers, health, model: 'auto', policy: 'fastest' });
  assert.deepEqual(out.map((c) => c.provider.name), ['fast', 'slow', 'cheap']);
  assert.deepEqual(out.map((c) => c.model), ['small', 'big', 'tiny']);
});

test('unhealthy providers are demoted to the back of the chain', () => {
  const health = new Map([
    ['slow', fresh(50, false)],
    ['fast', fresh(900)],
    ['cheap', fresh(10)],
  ]);
  const out = selectCandidates({ providers, health, model: 'auto', policy: 'fastest' });
  // Among the healthy, 'cheap' (10ms) still beats 'fast' (900ms); the dead
  // 'slow' provider sinks despite its 50ms reading.
  assert.deepEqual(out.map((c) => c.provider.name), ['cheap', 'fast', 'slow']);
});

test('provider/model prefix routes explicitly', () => {
  const out = selectCandidates({ providers, health: new Map(), model: 'fast/shared' });
  assert.equal(out.length, 1);
  assert.equal(out[0].provider.name, 'fast');
  assert.equal(out[0].model, 'shared');
});

test('unknown provider prefix yields no candidates', () => {
  const out = selectCandidates({ providers, health: new Map(), model: 'nope/shared' });
  assert.equal(out.length, 0);
});

test('bare model name matches every provider advertising it', () => {
  const out = selectCandidates({ providers, health: new Map(), model: 'shared' });
  assert.deepEqual(out.map((c) => c.provider.name), ['slow', 'fast']);
});

test('tools requests only reach tool-capable providers', () => {
  const out = selectCandidates({
    providers,
    health: new Map(),
    model: 'auto',
    requiresTools: true,
  });
  assert.deepEqual(out.map((c) => c.provider.name), ['slow', 'cheap']);
});

test('cheapest policy orders by cost', () => {
  const out = selectCandidates({ providers, health: new Map(), model: 'auto', policy: 'cheapest' });
  assert.deepEqual(out.map((c) => c.provider.name), ['cheap', 'fast', 'slow']);
});

test('stale health probes are treated as not-up', () => {
  const stale = { ok: true, latencyMs: 5, ts: Date.now() - 60 * 60 * 1000, note: null };
  const health = new Map([
    ['slow', fresh(9999)],
    ['fast', stale],
    ['cheap', fresh(9999)],
  ]);
  const out = selectCandidates({ providers, health, model: 'auto', policy: 'fastest' });
  // 'fast' has the best latency but stale health, so it sinks behind the
  // fresh-but-slow providers.
  assert.equal(out[out.length - 1].provider.name, 'fast');
});
