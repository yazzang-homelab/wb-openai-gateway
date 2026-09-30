#!/usr/bin/env node
/**
 * A mock OpenAI-compatible model server.
 *
 * Point the bundled CLI at it to exercise the whole stack without a real model
 * account:
 *
 *   CODEBUDDY_API_KEY=test \
 *   CODEBUDDY_BASE_URL=http://127.0.0.1:8099/v1 \
 *   codebuddy --serve --port 8399 --model <model>
 *
 * It answers with a canned assistant message and can be told to emit a tool-call
 * envelope, which makes it useful for end-to-end testing of the gateway's
 * function-calling bridge.
 *
 *   node tools/mock-model.mjs [--port 8099] [--answer "text"] [--tool name] [--args '{"k":"v"}']
 *
 * Every request is logged so you can see exactly what the CLI sends.
 */
import http from 'node:http';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

const PORT = Number(arg('--port', '8099'));
const MODEL = arg('--model', 'mock-model');
const TOOL = arg('--tool', null);
const TOOL_ARGS = arg('--args', '{}');
const ANSWER = arg('--answer', null);
const VERBOSE = argv.includes('--verbose');

const answerText = () => {
  if (ANSWER) return ANSWER;
  if (TOOL) return JSON.stringify({ wb_tool_call: { name: TOOL, arguments: JSON.parse(TOOL_ARGS) } });
  return 'MOCK_REPLY: this response came from the mock model server.';
};

let requests = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    requests += 1;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }

    const summary = {
      n: requests,
      method: req.method,
      url: req.url,
      model: body?.model,
      stream: body?.stream === true,
      messages: Array.isArray(body?.messages) ? body.messages.length : 0,
      tools: Array.isArray(body?.tools) ? body.tools.length : 0
    };
    process.stdout.write(`[mock-model] ${JSON.stringify(summary)}\n`);
    if (VERBOSE) {
      process.stdout.write(`[mock-model] headers: ${JSON.stringify(req.headers, null, 2)}\n`);
      process.stdout.write(`[mock-model] body: ${JSON.stringify(body, null, 2).slice(0, 4000)}\n`);
    }

    const text = answerText();
    const id = `chatcmpl-mock-${requests}`;
    const created = Math.floor(Date.now() / 1000);

    // Model listing, in case the client probes for it.
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', created, owned_by: 'mock' }] }));
      return;
    }

    if (!/\/chat\/completions$/.test(req.url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${req.url}`, type: 'invalid_request_error' } }));
      return;
    }

    if (body?.stream === true) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      frame({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      frame({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      frame({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model: MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[mock-model] listening on http://127.0.0.1:${PORT}/v1\n`);
  process.stdout.write(
    `[mock-model] mode: ${TOOL ? `tool call -> ${TOOL}` : 'plain text'}${VERBOSE ? ' (verbose)' : ''}\n`
  );
});
