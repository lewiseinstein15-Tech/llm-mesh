// Config loading: env secrets, validation, policy checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveSecret } from '../src/config.js';

function writeConfig(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

const baseProvider = {
  name: 'p1',
  baseUrl: 'http://localhost:1/v1',
  apiKey: 'none',
  models: ['m1'],
};

test('resolveSecret handles env refs, none and literals', () => {
  process.env.MESH_TEST_SECRET = 'shhh';
  assert.equal(resolveSecret('env:MESH_TEST_SECRET'), 'shhh');
  assert.equal(resolveSecret('env:MESH_TEST_MISSING'), null);
  assert.equal(resolveSecret('none'), null);
  assert.equal(resolveSecret(''), null);
  assert.equal(resolveSecret('literal-key'), 'literal-key');
  assert.equal(resolveSecret(undefined), null);
  delete process.env.MESH_TEST_SECRET;
});

test('loadConfig normalizes providers and trims baseUrl slashes', () => {
  const cfg = loadConfig(
    writeConfig({
      port: 9999,
      policy: 'fastest',
      providers: [{ ...baseProvider, baseUrl: 'http://localhost:1/v1/', cost: 0 }],
    })
  );
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.policy, 'fastest');
  assert.equal(cfg.providers[0].baseUrl, 'http://localhost:1/v1');
  assert.equal(cfg.providers[0].keyless, true);
  assert.equal(cfg.providers[0].apiKey, null);
  assert.equal(cfg.providers[0].order, 0);
});

test('loadConfig rejects duplicate provider names', () => {
  assert.throws(
    () => loadConfig(writeConfig({ providers: [baseProvider, { ...baseProvider }] })),
    /duplicate provider name/
  );
});

test('loadConfig rejects unknown policies and empty provider lists', () => {
  assert.throws(() => loadConfig(writeConfig({ policy: 'chaotic', providers: [baseProvider] })), /unknown policy/);
  assert.throws(() => loadConfig(writeConfig({ providers: [] })), /no providers/);
  assert.throws(() => loadConfig(writeConfig({ providers: [{ baseUrl: 'x' }] })), /missing a name/);
});

test('loadConfig resolves env: keys into provider.apiKey', () => {
  process.env.MESH_TEST_PROVIDER_KEY = 'pk';
  const cfg = loadConfig(
    writeConfig({ providers: [{ ...baseProvider, apiKey: 'env:MESH_TEST_PROVIDER_KEY' }] })
  );
  assert.equal(cfg.providers[0].apiKey, 'pk');
  assert.equal(cfg.providers[0].keyless, false);
  delete process.env.MESH_TEST_PROVIDER_KEY;
});

test('loadConfig falls back to MESH_KEY env when key unset', () => {
  process.env.MESH_KEY = 'mesh-secret';
  const cfg = loadConfig(writeConfig({ providers: [baseProvider] }));
  assert.equal(cfg.key, 'mesh-secret');
  delete process.env.MESH_KEY;
});
