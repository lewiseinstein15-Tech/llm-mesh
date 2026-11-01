// End-to-end: real HTTP server in front of mock upstreams.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMesh } from '../src/server.js';
import { openStore } from '../src/store.js';
import { createMockUpstream } from './mock-upstream.js';

async function startMesh({ providers, key = 'test-key' }) {
  const store = openStore(':memory:');
  const config = {
    host: '127.0.0.1',
    port: 0,
    key,
    policy: 'config',
    probeIntervalMs: 30000,
    requestTimeoutMs: 5000,
    database: ':memory:',
    providers,
  };
  const server = createMesh({ config, store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    store,
    close: () =>
      new Promise((resolve) => {
        store.close();
        server.close(resolve);
      }),
  };
}

test('/health is open and reports probe state', async () => {
  const up = await createMockUpstream();
  const mesh = await startMesh({ providers: [up.provider({ name: 'mock' })], key: 'k' });
  mesh.store.recordHealth({ provider: 'mock', ok: true, latencyMs: 42, ts: Date.now() });

  const res = await fetch(`${mesh.base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.providers[0].name, 'mock');
  assert.equal(body.providers[0].up, true);
  assert.equal(body.providers[0].latencyMs, 42);
  await mesh.close();
  await up.close();
});

test('/v1 endpoints require the bearer key', async () => {
  const up = await createMockUpstream();
  const mesh = await startMesh({ providers: [up.provider({ name: 'mock' })], key: 'right-key' });

  const noKey = await fetch(`${mesh.base}/v1/models`);
  assert.equal(noKey.status, 401);

  const wrongKey = await fetch(`${mesh.base}/v1/models`, {
    headers: { authorization: 'Bearer wrong-key' },
  });
  assert.equal(wrongKey.status, 401);

  const ok = await fetch(`${mesh.base}/v1/models`, {
    headers: { authorization: 'Bearer right-key' },
  });
  assert.equal(ok.status, 200);
  const models = await ok.json();
  assert.deepEqual(models.data.map((m) => m.id), ['mock-model']);
  assert.equal(models.data[0].owned_by, 'mock');
  await mesh.close();
  await up.close();
});

test('chat completions proxies through and records usage', async () => {
  const up = await createMockUpstream({ content: 'proxied' });
  const mesh = await startMesh({ providers: [up.provider({ name: 'mock' })], key: 'k' });

  const res = await fetch(`${mesh.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'proxied');
  assert.equal(body.model, 'mock-model');

  const usage = mesh.store.recentUsage();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].provider, 'mock');
  assert.equal(usage[0].tokensIn, 11);
  assert.equal(usage[0].tokensOut, 7);
  assert.equal(usage[0].exact, true);
  await mesh.close();
  await up.close();
});

test('streaming chat completions yields SSE end to end', async () => {
  const up = await createMockUpstream({ content: 'streamed answer' });
  const mesh = await startMesh({ providers: [up.provider({ name: 'mock' })], key: 'k' });

  const res = await fetch(`${mesh.base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer k',
      'x-mesh-agent': 'engineer-buddy',
    },
    body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes('streamed answer'));
  assert.ok(text.includes('data: [DONE]'));

  const usage = mesh.store.recentUsage();
  assert.equal(usage[0].agent, 'engineer-buddy');
  assert.equal(usage[0].tokensOut, 7);
  await mesh.close();
  await up.close();
});

test('failing provider chain ends in a 502 mesh error', async () => {
  const up = await createMockUpstream({ status: 500 });
  const mesh = await startMesh({ providers: [up.provider({ name: 'mock' })], key: 'k' });

  const res = await fetch(`${mesh.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    body: JSON.stringify({ model: 'auto', messages: [] }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error.message, /all providers failed/);
  await mesh.close();
  await up.close();
});

test('unknown model name is a 404, not a silent misroute', async () => {
  const up = await createMockUpstream();
  const mesh = await startMesh({ providers: [up.provider({ name: 'mock' })], key: 'k' });

  const res = await fetch(`${mesh.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    body: JSON.stringify({ model: 'nonexistent-model', messages: [] }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error.message, /no provider can serve/);
  await mesh.close();
  await up.close();
});

test('/v1/usage returns the recorded log', async () => {
  const up = await createMockUpstream();
  const mesh = await startMesh({ providers: [up.provider({ name: 'mock' })], key: 'k' });
  mesh.store.recordUsage({ provider: 'mock', model: 'm', tokensIn: 3, tokensOut: 4, exact: true });

  const res = await fetch(`${mesh.base}/v1/usage`, { headers: { authorization: 'Bearer k' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].tokensIn, 3);
  await mesh.close();
  await up.close();
});
