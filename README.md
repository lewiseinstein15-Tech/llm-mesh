# llm-mesh

**One local endpoint in front of all your LLM providers.** An OpenAI-compatible proxy that routes each request across providers with health-aware failover — running on your machine, keys never leaving it.

```
arcen ───────┐
engineer-buddy ┼──▶ http://localhost:8080/v1 ──▶ Groq / OpenAI / Together / Ollama / keyless…
jexi-os ──────┘         (one Node process)
```

- **Zero runtime dependencies.** `node:http`, `node:sqlite`, global `fetch`. Nothing to install.
- **OpenAI-compatible.** Point any OpenAI SDK, agent, or `curl` at it — nothing else changes.
- **Health-aware routing.** A prober pings every provider every 30s; the router puts healthy, fast ones first and sinks the rest.
- **Failover before tokens.** If a provider is down or errors, the next candidate answers on the same open response. Once tokens have actually reached the client the mesh never rewinds (that would duplicate text) — it reports the failure honestly instead.
- **Everything is logged.** Provider, model, which agent asked, tokens in/out (exact where the provider reports them, estimated otherwise — labeled), latency, attempts. One SQLite file: `mesh.db`.

## Quick start

```bash
node src/index.js
# [mesh] listening on http://127.0.0.1:8080/v1
```

The default `mesh.config.json` ships with **pollinations (keyless)** working out of the box, plus groq/openai/together (keys read from env) and local Ollama. Then:

```bash
# is anything up?
curl -s http://localhost:8080/health | jq

# chat through the mesh (key = "key" in config, or MESH_KEY env)
curl -s http://localhost:8080/v1/chat/completions \
  -H 'authorization: Bearer local-mesh-key' \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}],"stream":true}'

# what did it cost me today?
curl -s http://localhost:8080/v1/usage -H 'authorization: Bearer local-mesh-key' | jq
```

Point your agents at it by setting their OpenAI-compatible base URL to `http://localhost:8080/v1` and using any/any key.

## Configuration

`mesh.config.json` (or `MESH_CONFIG=path`, `--config path`):

```jsonc
{
  "host": "127.0.0.1",
  "port": 8080,
  "key": "local-mesh-key",        // or "env:MESH_KEY"; "none" = open (local only)
  "policy": "fastest",            // fastest | cheapest | config
  "probeIntervalMs": 30000,
  "requestTimeoutMs": 120000,
  "database": "mesh.db",
  "providers": [
    {
      "name": "groq",
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKey": "env:GROQ_API_KEY",   // "none" for keyless providers
      "models": ["llama-3.3-70b-versatile"],
      "capabilities": { "tools": true, "context": 128000 },
      "cost": 0
    }
  ]
}
```

**Model routing:** `"model": "auto"` picks by policy and health. `"model": "gpt-4o-mini"` picks any provider advertising it. `"model": "groq/llama-3.3-70b-versatile"` pins a specific provider.

**Secrets never live in the config** — use `env:NAME` references; the config file is safe to commit.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Provider status, latency, last probe |
| `POST /v1/chat/completions` | Bearer | The mesh — streaming and non-streaming |
| `GET /v1/models` | Bearer | Aggregated model list across providers |
| `GET /v1/usage?limit=50` | Bearer | Recent usage log from `mesh.db` |

Requests can carry `x-mesh-agent: <name>` to tag the usage log with which agent asked.

## Tests

```bash
npm test        # node:test, uses mock upstreams — no keys, no network
```

## Roadmap

- **✅ Milestone 1** — OpenAI-compatible facade, key check, streaming pass-through, SQLite store, usage log.
- **✅ Milestone 2 (core)** — prober, health-first routing, capability filter, pre-token failover.
- **⬜ Milestone 2 (rest)** — mid-stream restart with output stitching, per-provider rate limiting, circuit breaker cooldowns.
- **⬜ Milestone 3** — accounts, quotas, spend caps, usage dashboard (only if this ever gets sold).
- **⬜ Anthropic adapter** — non-OpenAI wire format translation.

## License

MIT
