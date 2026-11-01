// Relay: sends a request down the candidate chain until one answers.
// Streaming rule: a candidate is abandoned before any token reaches the
// client; once tokens have been emitted, we never rewind — we emit an error
// event and end, because silently restarting would duplicate text.

export function buildUpstreamBody(body, model) {
  const out = { ...body, model };
  if (body.stream) out.stream_options = { include_usage: true };
  return out;
}

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

export async function callProvider({ provider, model, body, signal, fetchImpl = fetch }) {
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildUpstreamBody(body, model)),
    signal,
  });
  return res;
}

/**
 * Relay the request across the ordered candidate chain.
 * Returns { provider?, model?, attempts, failed }.
 */
export async function relay({
  candidates,
  body,
  clientRes,
  timeoutMs = 120000,
  logUsage = () => {},
  fetchImpl = fetch,
}) {
  const stream = Boolean(body.stream);
  const attempts = [];

  for (const candidate of candidates) {
    const { provider, model } = candidate;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await callProvider({ provider, model, body, signal: controller.signal, fetchImpl });
    } catch (err) {
      attempts.push({ provider: provider.name, error: String(err?.message || err) });
      clearTimeout(timer);
      continue;
    }

    if (!res.ok) {
      attempts.push({ provider: provider.name, status: res.status });
      clearTimeout(timer);
      continue;
    }

    if (!stream) {
      let text;
      try {
        text = await res.text();
      } catch (err) {
        attempts.push({ provider: provider.name, error: String(err?.message || err) });
        clearTimeout(timer);
        continue;
      }
      clearTimeout(timer);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        attempts.push({ provider: provider.name, error: 'provider returned non-JSON body' });
        continue;
      }
      logUsage({
        provider: provider.name,
        model: json.model || model,
        agent: body.agent,
        tokensIn: json.usage?.prompt_tokens ?? null,
        tokensOut: json.usage?.completion_tokens ?? null,
        exact: Boolean(json.usage),
        latencyMs: Date.now() - startedAt,
        status: res.status,
        attempts: attempts.length + 1,
      });
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify(json));
      return { provider: provider.name, model, attempts, failed: false };
    }

    // Streaming: commit to this candidate and pipe bytes straight through.
    clientRes.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    let contentChars = 0;
    let streamError = null;

    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            clientRes.write('data: [DONE]\n\n');
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) usage = parsed.usage;
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) contentChars += delta.length;
          } catch {
            // Not JSON we understand — forward it untouched rather than drop it.
          }
          clientRes.write(`data: ${data}\n\n`);
        }
      }
    } catch (err) {
      streamError = err;
    } finally {
      clearTimeout(timer);
    }

    if (buffer.trim()) clientRes.write(`data: ${buffer.trim()}\n\n`);

    logUsage({
      provider: provider.name,
      model,
      agent: body.agent,
      tokensIn: usage?.prompt_tokens ?? null,
      tokensOut: usage?.completion_tokens ?? (contentChars ? estimateTokens(`x`.repeat(contentChars)) : null),
      exact: Boolean(usage),
      latencyMs: Date.now() - startedAt,
      status: res.status,
      failed: streamError ? 1 : 0,
      attempts: attempts.length + 1,
    });

    if (streamError && contentChars === 0 && candidate !== candidates[candidates.length - 1]) {
      // Nothing reached the client — safe to try the next candidate on the
      // same open response stream.
      attempts.push({ provider: provider.name, error: String(streamError?.message || streamError) });
      continue;
    }

    if (streamError) {
      clientRes.write(
        `data: ${JSON.stringify({
          error: { message: `mesh: upstream ${provider.name} failed mid-stream`, type: 'mesh_error' },
        })}\n\n`
      );
    }
    clientRes.end();
    return { provider: provider.name, model, attempts, failed: Boolean(streamError) };
  }

  // Every candidate failed before producing output.
  const detail = attempts.map((a) => `${a.provider}:${a.error || a.status}`).join(', ');
  logUsage({
    provider: 'none',
    model: body.model,
    agent: body.agent,
    latencyMs: null,
    status: 502,
    failed: 1,
    attempts: attempts.length,
  });
  clientRes.writeHead(502, { 'content-type': 'application/json' });
  clientRes.end(
    JSON.stringify({
      error: { message: `mesh: all providers failed (${detail || 'no candidates'})`, type: 'mesh_error' },
    })
  );
  return { attempts, failed: true };
}
