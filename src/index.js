#!/usr/bin/env node
// mesh — local-first LLM inference mesh entry point.
import { loadConfig, DEFAULT_CONFIG_PATH } from './config.js';
import { openStore } from './store.js';
import { createMesh } from './server.js';
import { startProber } from './prober.js';

function parseArgs(argv) {
  const args = { config: process.env.MESH_CONFIG || DEFAULT_CONFIG_PATH, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--port' || a === '-p') args.port = Number(argv[++i]);
    else if (a === '--help' || a === -1) {
      console.log(`usage: mesh [--config path] [--port n]

  --config, -c   path to mesh.config.json (default: ./mesh.config.json)
  --port,   -p   override the configured listen port`);
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);
if (args.port) config.port = args.port;

const store = openStore(config.database);
const server = createMesh({ config, store });

const keyless = config.key === null;
if (keyless) {
  console.warn('[mesh] no "key" configured — the proxy is OPEN to anything on this machine');
}

const prober = startProber({
  providers: config.providers,
  store,
  intervalMs: config.probeIntervalMs,
  log: (results) => {
    const line = results.map((r) => `${r.provider}=${r.ok ? 'up' : 'down'}(${r.latencyMs}ms)`).join(' ');
    console.log(`[probe] ${line}`);
  },
});

server.listen(config.port, config.host, () => {
  console.log(`[mesh] listening on http://${config.host}:${config.port}/v1`);
  console.log(`[mesh] policy=${config.policy} providers=${config.providers.map((p) => p.name).join(',')}`);
  console.log(`[mesh] try: curl http://${config.host}:${config.port}/health`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[mesh] ${signal} — shutting down`);
    prober.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
