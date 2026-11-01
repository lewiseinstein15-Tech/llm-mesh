// SQLite persistence: provider health history + usage log. One file, zero deps.
import { DatabaseSync } from 'node:sqlite';

export function openStore(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS health (
      provider   TEXT    NOT NULL,
      ts         INTEGER NOT NULL,
      ok         INTEGER NOT NULL,
      latency_ms INTEGER,
      note       TEXT
    );
    CREATE INDEX IF NOT EXISTS health_by_provider ON health(provider, ts);
    CREATE TABLE IF NOT EXISTS usage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      provider   TEXT    NOT NULL,
      model      TEXT,
      agent      TEXT,
      tokens_in  INTEGER,
      tokens_out INTEGER,
      exact      INTEGER NOT NULL DEFAULT 1,
      latency_ms INTEGER,
      status     INTEGER,
      failed     INTEGER NOT NULL DEFAULT 0,
      attempts   INTEGER NOT NULL DEFAULT 1
    );
  `);

  return {
    recordHealth({ provider, ts = Date.now(), ok, latencyMs = null, note = null }) {
      db.prepare(
        'INSERT INTO health (provider, ts, ok, latency_ms, note) VALUES (?, ?, ?, ?, ?)'
      ).run(provider, ts, ok ? 1 : 0, latencyMs, note);
    },

    // Latest probe per provider: Map<name, {ok, latencyMs, ts, note}>
    latestHealth() {
      const rows = db.prepare(
        'SELECT provider, ts, ok, latency_ms, note FROM health ORDER BY ts ASC'
      ).all();
      const map = new Map();
      for (const r of rows) {
        map.set(r.provider, {
          ok: r.ok === 1,
          latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
          ts: Number(r.ts),
          note: r.note ?? null,
        });
      }
      return map;
    },

    recordUsage(entry) {
      db.prepare(
        `INSERT INTO usage
           (ts, provider, model, agent, tokens_in, tokens_out, exact, latency_ms, status, failed, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.ts ?? Date.now(),
        entry.provider,
        entry.model ?? null,
        entry.agent ?? null,
        entry.tokensIn ?? null,
        entry.tokensOut ?? null,
        entry.exact ? 1 : 0,
        entry.latencyMs ?? null,
        entry.status ?? null,
        entry.failed ? 1 : 0,
        entry.attempts ?? 1
      );
    },

    recentUsage(limit = 50) {
      return db
        .prepare(
          `SELECT ts, provider, model, agent, tokens_in AS tokensIn, tokens_out AS tokensOut,
                  exact, latency_ms AS latencyMs, status, failed, attempts
             FROM usage ORDER BY id DESC LIMIT ?`
        )
        .all(limit)
        .map((r) => ({ ...r, exact: r.exact === 1, failed: r.failed === 1, ts: Number(r.ts) }));
    },

    close() {
      db.close();
    },
  };
}
