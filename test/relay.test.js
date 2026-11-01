// Relay: pass-through, failover before tokens, no-rewind after tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { relay } from '../src/relay.js';
import { createMockUpstream, makeClientRes, sseEvents } from './mock-upstream.js';

test('non-stream request returns JSON and logs exact usage', async () => {
  const up = await createMockUpstream({ content: 'plain answer' });
  const usage = [];
  const res = makeClientRes();

  const out = await relay({
    candidates: [{ provider: up.provider(), model: 'mock-model' }],
    body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    clientRes: res,
    logUsage: (u) => usage.push(u),
  });

  assert.equal(out.failed, false);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.choices[0].message.content, 'plain answer');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].tokensIn, 11);
  assert.equal(usage[0].tokensOut, 7);
  assert.equal(usage[0].exact, true);
  assert.equal(usage[0].attempts, 1);
  await up.close();
});

test('a 500 from the first provider fails over to the next', async () => {
  const bad = await createMockUpstream({ status: 500 });
  const good = await createMockUpstream({ content: 'rescued' });
  const usage = [];
  const res = makeClientRes();

  const out = await relay({
    candidates: [
      { provider: bad.provider({ name: 'bad' }), model: 'mock-model' },
      { provider: good.provider({ name: 'good' }), model: 'mock-model' },
    ],
    body: { messages: [{ role: 'user', content: 'hi' }] },
    clientRes: res,
    logUsage: (u) => usage.push(u),
  });

  assert.equal(out.provider, 'good');
  assert.equal(out.attempts.length, 1); // the failed attempt, before success
  assert.equal(JSON.parse(res.body).choices[0].message.content, 'rescued');
  assert.equal(usage[0].attempts, 2);
  await bad.close();
  await good.close();
});

test('streaming request relays SSE chunks and captures usage', async () => {
  const up = await createMockUpstream();
  const usage = [];
  const res = makeClientRes();

  await relay({
    candidates: [{ provider: up.provider(), model: 'mock-model' }],
    body: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
    clientRes: res,
    logUsage: (u) => usage.push(u),
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  const events = sseEvents(res.body);
  assert.ok(res.body.includes('data: [DONE]'));
  const content = events
    .filter((e) => e !== '[DONE]')
    .map((e) => JSON.parse(e).choices?.[0]?.delta?.content ?? '')
    .join('');
  assert.equal(content, 'hello from mock');
  assert.equal(usage[0].exact, true);
  assert.equal(usage[0].tokensOut, 7);
  await up.close();
});

test('provider that dies before any token fails over on the open stream', async () => {
  const dead = await createMockUpstream({ destroyBeforeBody: true });
  const good = await createMockUpstream({ content: 'second try' });
  const res = makeClientRes();

  const out = await relay({
    candidates: [
      { provider: dead.provider({ name: 'dead' }), model: 'mock-model' },
      { provider: good.provider({ name: 'good' }), model: 'mock-model' },
    ],
    body: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
    clientRes: res,
    logUsage: () => {},
  });

  assert.equal(out.failed, false);
  assert.equal(out.provider, 'good');
  assert.ok(res.body.includes('data: [DONE]'));
  assert.ok(res.body.includes('second try'));
  await dead.close();
  await good.close();
});

test('mid-stream failure after tokens are sent does NOT restart — it reports', async () => {
  const dying = await createMockUpstream({ destroyAfterFirstChunk: true });
  const backup = await createMockUpstream({ content: 'should not appear' });
  const res = makeClientRes();

  const out = await relay({
    candidates: [
      { provider: dying.provider({ name: 'dying' }), model: 'mock-model' },
      { provider: backup.provider({ name: 'backup' }), model: 'mock-model' },
    ],
    body: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
    clientRes: res,
    logUsage: () => {},
  });

  // Text already reached the client, so restarting would duplicate it.
  assert.equal(out.provider, 'dying');
  assert.equal(out.failed, true);
  assert.ok(res.body.includes('partial'));
  assert.ok(!res.body.includes('should not appear'));
  assert.ok(res.body.includes('mesh_error'));
  assert.equal(backup.state.requests.length, 0);
  await dying.close();
  await backup.close();
});

test('every candidate failing yields a 502 with the attempt list', async () => {
  const a = await createMockUpstream({ status: 503 });
  const b = await createMockUpstream({ destroyBeforeBody: true });
  const res = makeClientRes();

  const out = await relay({
    candidates: [
      { provider: a.provider({ name: 'a' }), model: 'm' },
      { provider: b.provider({ name: 'b' }), model: 'm' },
    ],
    body: { messages: [] },
    clientRes: res,
    logUsage: () => {},
  });

  assert.equal(out.failed, true);
  assert.equal(res.statusCode, 502);
  const err = JSON.parse(res.body).error;
  assert.match(err.message, /all providers failed/);
  assert.match(err.message, /a:503/);
  await a.close();
  await b.close();
});

test('stream_options.include_usage is injected so providers report tokens', async () => {
  const up = await createMockUpstream();
  await relay({
    candidates: [{ provider: up.provider(), model: 'mock-model' }],
    body: { stream: true, messages: [] },
    clientRes: makeClientRes(),
    logUsage: () => {},
  });
  assert.deepEqual(up.state.requests[0].body.stream_options, { include_usage: true });
  await up.close();
});
