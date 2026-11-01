// Mock upstream OpenAI-compatible providers for relay/server tests.
import { createServer } from 'node:http';

export function makeClientRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    ended: false,
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      this.body += chunk;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.ended = true;
    },
  };
}

export function sseEvents(body) {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6));
}

/**
 * @param {object} [options]
 * @param {number} [options.status]        respond with this HTTP status to /chat/completions
 * @param {boolean} [options.destroyBeforeBody] kill the socket before sending anything
 * @param {boolean} [options.destroyAfterFirstChunk] send one SSE chunk then die
 * @param {string}  [options.content]      assistant text to return
 */
export async function createMockUpstream(options = {}) {
  const state = { requests: [] };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[]}');
        return;
      }

      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* keep {} */
      }
      state.requests.push({ url: req.url, auth: req.headers.authorization, body });

      if (options.destroyBeforeBody) {
        res.socket.destroy();
        return;
      }
      if (options.status && options.status >= 400) {
        res.writeHead(options.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock failure' } }));
        return;
      }

      const content = options.content ?? 'hello from mock';

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (options.destroyAfterFirstChunk) {
          // Flush the chunk to the client BEFORE killing the socket — the
          // relay must see real output before refusing to rewind.
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial ' } }] })}\n\n`,
            () => setTimeout(() => res.socket.destroy(), 15)
          );
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock-1',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        })
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    provider(overrides = {}) {
      return {
        name: 'mock',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: null,
        keyless: true,
        models: ['mock-model'],
        capabilities: { tools: false, context: 8000 },
        cost: 1,
        order: 0,
        ...overrides,
      };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
