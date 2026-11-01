// Loads mesh.config.json, resolves `env:NAME` secrets, validates the shape.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../mesh.config.json', import.meta.url));

// "env:GROQ_API_KEY" -> process.env.GROQ_API_KEY, "none"/"" -> null (keyless).
export function resolveSecret(value) {
  if (typeof value !== 'string') return null;
  if (value === '' || value.toLowerCase() === 'none') return null;
  if (value.startsWith('env:')) return process.env[value.slice(4)] || null;
  return value;
}

export function loadConfig(path = process.env.MESH_CONFIG || DEFAULT_CONFIG_PATH) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read config at ${path}: ${err.message}`);
  }

  const seen = new Set();
  const providers = (raw.providers || []).map((p, i) => {
    if (!p || !p.name) throw new Error(`providers[${i}] is missing a name`);
    if (seen.has(p.name)) throw new Error(`duplicate provider name "${p.name}"`);
    seen.add(p.name);
    const baseUrl = String(p.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error(`provider "${p.name}" is missing baseUrl`);
    const apiKey = resolveSecret(p.apiKey);
    return {
      name: p.name,
      baseUrl,
      apiKey,
      keyless: apiKey === null,
      models: Array.isArray(p.models) ? p.models : [],
      capabilities: {
        tools: Boolean(p.capabilities && p.capabilities.tools),
        context: (p.capabilities && p.capabilities.context) || 0,
      },
      cost: typeof p.cost === 'number' ? p.cost : 1,
      order: i,
    };
  });

  if (providers.length === 0) throw new Error('config declares no providers');

  const allowedPolicies = new Set(['fastest', 'cheapest', 'config']);
  const policy = raw.policy || 'config';
  if (!allowedPolicies.has(policy)) {
    throw new Error(`unknown policy "${policy}" (expected one of: ${[...allowedPolicies].join(', ')})`);
  }

  return {
    host: raw.host || '127.0.0.1',
    port: Number(raw.port) || 8080,
    key: resolveSecret(raw.key) ?? resolveSecret('env:MESH_KEY') ?? null,
    policy,
    probeIntervalMs: Number(raw.probeIntervalMs) || 30000,
    requestTimeoutMs: Number(raw.requestTimeoutMs) || 120000,
    database: raw.database || 'mesh.db',
    providers,
  };
}
