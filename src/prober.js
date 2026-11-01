// Prober: periodically pings every provider so the router routes on evidence
// instead of hope. Reachable-but-erroring (4xx/401) counts as up — the host
// answered; only network errors and 5xx count as down.

export async function probeProvider({ provider, fetchImpl = fetch, timeoutMs = 5000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const headers = {};
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    const res = await fetchImpl(`${provider.baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const ok = res.status < 500;
    // Drain the body so the socket is released.
    try {
      await res.arrayBuffer();
    } catch {
      /* body is irrelevant to a health check */
    }
    return { provider: provider.name, ok, latencyMs, note: res.status === 200 ? null : `HTTP ${res.status}` };
  } catch (err) {
    return {
      provider: provider.name,
      ok: false,
      latencyMs: Date.now() - startedAt,
      note: String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAll({ providers, store, fetchImpl = fetch, timeoutMs = 5000 }) {
  const results = await Promise.all(
    providers.map((p) => probeProvider({ provider: p, fetchImpl, timeoutMs }))
  );
  for (const r of results) store.recordHealth(r);
  return results;
}

export function startProber({ providers, store, intervalMs = 30000, fetchImpl = fetch, log = () => {} }) {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap probes
    running = true;
    try {
      const results = await probeAll({ providers, store, fetchImpl });
      log(results);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  const first = tick();
  return { handle, stop: () => clearInterval(handle), first };
}
