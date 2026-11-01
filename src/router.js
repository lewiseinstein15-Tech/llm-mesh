// Router: turns (requested model, policy, health snapshot) into an ordered
// attempt chain of { provider, model } pairs.

// Health is considered fresh for 5 probe intervals.
const HEALTH_FRESH_MS_FACTOR = 5;

function isUp(entry, probeIntervalMs, now) {
  if (!entry || !entry.ok) return false;
  return now - entry.ts < HEALTH_FRESH_MS_FACTOR * probeIntervalMs;
}

function latencyOf(entry) {
  return entry && entry.latencyMs != null ? entry.latencyMs : 99999;
}

/**
 * @param {object} args
 * @param {Array} args.providers   normalized providers from config
 * @param {Map}   args.health      latest probe per provider name
 * @param {string} args.model      requested model ("auto" for routing)
 * @param {string} args.policy     fastest | cheapest | config
 * @param {number} args.probeIntervalMs
 * @param {boolean[]} [args.requiresTools] capability the request needs
 * @returns {Array<{provider: object, model: string}>} ordered attempt chain
 */
export function selectCandidates({
  providers,
  health = new Map(),
  model = 'auto',
  policy = 'config',
  probeIntervalMs = 30000,
  requiresTools = false,
}) {
  const now = Date.now();

  // 1. Which provider/model pairs can serve this request at all?
  let pairs;
  if (!model || model === 'auto') {
    pairs = providers.filter((p) => p.models.length > 0).map((p) => ({ provider: p, model: p.models[0] }));
  } else {
    const slash = model.indexOf('/');
    if (slash > 0) {
      // Explicit "provider/model" routing.
      const prefix = model.slice(0, slash);
      const target = model.slice(slash + 1);
      const p = providers.find((x) => x.name === prefix);
      pairs = p ? [{ provider: p, model: target }] : [];
    } else {
      // A model name — every provider that advertises it can serve it.
      pairs = providers.filter((p) => p.models.includes(model)).map((p) => ({ provider: p, model }));
    }
  }

  // 2. Capability filter (tools support), if the request needs it.
  if (requiresTools) pairs = pairs.filter((c) => c.provider.capabilities.tools);

  // 3. Stable sorts, weakest requirement last: policy order, then healthy first.
  if (policy === 'fastest') {
    pairs.sort(
      (a, b) => latencyOf(health.get(a.provider.name)) - latencyOf(health.get(b.provider.name))
    );
  } else if (policy === 'cheapest') {
    pairs.sort((a, b) => a.provider.cost - b.provider.cost || a.provider.order - b.provider.order);
  } else {
    pairs.sort((a, b) => a.provider.order - b.provider.order);
  }
  pairs.sort((a, b) => {
    const upA = isUp(health.get(a.provider.name), probeIntervalMs, now);
    const upB = isUp(health.get(b.provider.name), probeIntervalMs, now);
    if (upA === upB) return 0;
    return upA ? -1 : 1;
  });

  return pairs;
}
