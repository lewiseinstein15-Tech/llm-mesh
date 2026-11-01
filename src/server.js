// HTTP facade: OpenAI-compatible surface + health/usage endpoints.
// One local key, checked with a constant-time compare.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { selectCandidates } from './router.js';
import { relay } from './relay.js';

function keyMatches(presented, configured) {
  if (!configured) return true; // no key configured = open local proxy
  const a = Buffer.from(String(presented || ''));
  const b = Buffer.from(configured);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(req, config) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return keyMatches(token, config.key);
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readBody(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createMesh({ config, store, fetchImpl = fetch }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      // --- open endpoints (no auth) ---
      if (req.method === 'GET' && url.pathname === '/health') {
        const health = store.latestHealth();
        return json(res, 200, {
          ok: true,
          providers: config.providers.map((p) => {
            const h = health.get(p.name);
            return {
              name: p.name,
              up: h ? h.ok : null,
              latencyMs: h ? h.latencyMs : null,
              lastProbeMsAgo: h ? Date.now() - h.ts : null,
              note: h ? h.note : null,
              models: p.models,
            };
          }),
        });
      }

      // --- authenticated endpoints ---
      if (!authorize(req, config)) {
        return json(res, 401, {
          error: { message: 'mesh: missing or invalid bearer key', type: 'auth_error' },
        });
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const seen = new Set();
        const data = [];
        for (const p of config.providers) {
          for (const m of p.models) {
            if (seen.has(m)) continue;
            seen.add(m);
            data.push({ id: m, object: 'model', owned_by: p.name });
          }
        }
        return json(res, 200, { object: 'list', data });
      }

      if (req.method === 'GET' && url.pathname === '/v1/usage') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
        return json(res, 200, { object: 'list', data: store.recentUsage(limit) });
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, {
            error: { message: 'mesh: request body is not valid JSON', type: 'invalid_request_error' },
          });
        }

        const agent =
          req.headers['x-mesh-agent'] ||
          (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null);

        const candidates = selectCandidates({
          providers: config.providers,
          health: store.latestHealth(),
          model: body.model || 'auto',
          policy: config.policy,
          probeIntervalMs: config.probeIntervalMs,
          requiresTools: Array.isArray(body.tools) && body.tools.length > 0,
        });

        if (candidates.length === 0) {
          return json(res, 404, {
            error: {
              message: `mesh: no provider can serve model "${body.model || 'auto'}"`,
              type: 'invalid_request_error',
            },
          });
        }

        const outcome = await relay({
          candidates,
          body: { ...body, agent },
          clientRes: res,
          timeoutMs: config.requestTimeoutMs,
          logUsage: store.recordUsage,
          fetchImpl,
        });

        if (outcome.failed && !res.headersSent) return; // relay already answered 502
        return;
      }

      return json(res, 404, {
        error: { message: `mesh: unknown route ${req.method} ${url.pathname}`, type: 'invalid_request_error' },
      });
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* client already gone */
        }
        return;
      }
      return json(res, 500, {
        error: { message: `mesh: ${String(err?.message || err)}`, type: 'mesh_error' },
      });
    }
  });

  return server;
}
