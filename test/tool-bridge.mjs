#!/usr/bin/env node
/**
 * Tool-bridging tests.
 *
 * Runs the gateway against a *stub* upstream agent so the whole OpenAI
 * function-calling path is exercised deterministically, without needing a signed
 * in agent or a real model:
 *
 *   OpenAI tools -> prompt protocol -> agent reply -> parsed -> OpenAI tool_calls
 *
 * Also unit-tests the parser, because the safety property that matters is that a
 * reply which merely *contains* JSON is not mistaken for a tool call.
 *
 *   node test/tool-bridge.mjs
 */
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { JsonStore, ensureDir, loadOrCreateKey } from '../src/store.js';
import { TokenService } from '../src/tokens.js';
import { createServer } from '../src/server.js';
import {
  parseToolCall,
  normalizeTools,
  buildToolProtocol,
  toOpenAiTools,
  toPrompt
} from '../src/openai.js';
import { extractAnswer, jobPhase } from '../src/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', '.testdata');
const ACCESS_CODE = 'bridge-test-code';
const REDIRECT = 'http://127.0.0.1:7796/callback';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}\n`);
  }
};

const b64u = (b) => Buffer.from(b).toString('base64url');

// ------------------------------------------------------------------ stub agent

/** Minimal stand-in for `codebuddy --serve`. The canned answer is swappable. */
function startStubUpstream() {
  const state = { answer: '', updates: null, job: { state: 'done', settled: true }, prompts: [], dispatches: [], calls: [], jobSeq: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (body) => {
      const payload = JSON.stringify(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    };
    const readJson = (fn) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        state.calls.push({ method: req.method, path: url.pathname, body });
        fn(body);
      });
    };

    if (url.pathname === '/api/v1/health') return json({ data: { status: 'ok', pid: 1 } });
    if (url.pathname === '/api/v1/info') return json({ data: { userName: 'stub-user', version: 'stub' } });
    if (url.pathname === '/api/v1/auth/status') return json({ authEnabled: true, authenticated: true });

    if (url.pathname === '/api/v1/jobs' && req.method === 'POST') {
      return readJson((body) => {
        state.dispatches.push(body);
        state.prompts.push(body?.prompt ?? body);
        state.jobSeq += 1;
        json({ data: { id: `stub-${state.jobSeq}`, sessionId: `s-${state.jobSeq}`, state: 'working', settled: false } });
      });
    }

    const actionMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/(stop|reply)$/);
    if (actionMatch && req.method === 'POST') return readJson(() => json({ data: { ok: true } }));

    const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
    if (jobMatch) return json({ data: { job: { id: jobMatch[1], ...state.job } } });

    const transcriptMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/transcript$/);
    if (transcriptMatch) {
      return json({
        data: {
          sessionId: `s-${transcriptMatch[1]}`,
          updates:
            state.updates ??
            (state.answer
              ? [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: state.answer } }]
              : [])
        }
      });
    }

    if (url.pathname.startsWith('/api/v1/acp')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {}\n\n');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: url.pathname } }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port });
    });
  });
}

// ------------------------------------------------------------------- helpers

async function obtainToken(base, scope) {
  const reg = await (
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'bridge-test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', scope })
    })
  ).json();

  const verifier = b64u(crypto.randomBytes(32));
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const approve = await fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
      scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      decision: 'allow',
      access_code: ACCESS_CODE
    }).toString(),
    redirect: 'manual'
  });
  const code = new URL(approve.headers.get('location')).searchParams.get('code');
  const tok = await (
    await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: reg.client_id,
        code_verifier: verifier
      }).toString()
    })
  ).json();
  return tok.access_token;
}

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }
};

const envelope = (name, args) => JSON.stringify({ wb_tool_call: { name, arguments: args } });

// -------------------------------------------------------------- unit: parser

function unitTests() {
  process.stdout.write('\nparseToolCall (unit)\n');
  const tools = normalizeTools([WEATHER_TOOL]);

  const direct = parseToolCall(envelope('get_weather', { city: 'Seoul' }), tools);
  check('parses the documented envelope', direct?.name === 'get_weather' && direct.arguments.city === 'Seoul');

  const fenced = parseToolCall(`\`\`\`json\n${envelope('get_weather', { city: 'Busan' })}\n\`\`\``, tools);
  check('parses a fenced envelope', fenced?.name === 'get_weather' && fenced.arguments.city === 'Busan');

  const withProse = parseToolCall(`Sure, let me check that.\n${envelope('get_weather', { city: 'Incheon' })}\n`, tools);
  check('finds the envelope inside prose', withProse?.name === 'get_weather');

  const bare = parseToolCall(JSON.stringify({ name: 'get_weather', arguments: { city: 'Daegu' } }), tools);
  check('accepts a bare {name, arguments} object', bare?.name === 'get_weather');

  const openAiShape = parseToolCall(
    JSON.stringify({ tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Ulsan"}' } }] }),
    tools
  );
  check('accepts an OpenAI-shaped tool_calls payload', openAiShape?.name === 'get_weather' && openAiShape.arguments.city === 'Ulsan');

  const unknown = parseToolCall(envelope('delete_everything', { path: '/' }), tools);
  check('rejects a tool the client never declared', unknown === null, JSON.stringify(unknown));

  const plainText = parseToolCall('The weather in Seoul is sunny.', tools);
  check('plain text is not a tool call', plainText === null);

  const codeBlock = parseToolCall('Here is an example:\n```json\n{"name":"something_else","arguments":{}}\n```', tools);
  check('unrelated JSON in a code block is not a tool call', codeBlock === null);

  const noTools = parseToolCall(envelope('get_weather', {}), []);
  check('no declared tools means no parsing', noTools === null);

  check('normalizeTools drops nameless entries', normalizeTools([{ type: 'function', function: {} }, WEATHER_TOOL]).length === 1);

  process.stdout.write('\nbuildToolProtocol / toOpenAiTools\n');
  const protocol = buildToolProtocol(tools, 'auto');
  check('protocol names the tool', protocol.includes('get_weather'));
  check('protocol shows the envelope key', protocol.includes('wb_tool_call'));
  check('protocol embeds the schema', protocol.includes('"properties"'));

  const forced = buildToolProtocol(tools, { type: 'function', function: { name: 'get_weather' } });
  check('tool_choice can force a specific function', forced.includes('You must call "get_weather" now.'));

  const required = buildToolProtocol(tools, 'required');
  check('tool_choice=required is expressed', required.includes('exactly one of these tools'));

  const openAiTools = toOpenAiTools([
    { name: 'agent_run', description: 'Run a prompt', inputSchema: { type: 'object', properties: {} } }
  ]);
  check('MCP descriptors become OpenAI functions', openAiTools[0].type === 'function' && openAiTools[0].function.name === 'agent_run');
  check('inputSchema maps to parameters', openAiTools[0].function.parameters.type === 'object');

  process.stdout.write('\ntoPrompt\n');
  const multi = toPrompt(
    [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Seoul"}' } }] },
      { role: 'tool', name: 'get_weather', content: '{"tempC":21}' },
      { role: 'user', content: 'And tomorrow?' }
    ],
    { declaredTools: tools, toolsActive: true, toolChoice: 'auto' }
  );
  check('assistant tool_calls are replayed as history', multi.includes('requested tool call get_weather'));
  check('tool results are labelled with the tool name', multi.includes('Tool result (get_weather): {"tempC":21}'));
  check('the tool protocol is appended when active', multi.includes('wb_tool_call'));
  check('system prompt is preserved', multi.includes('Be terse.'));

  const singleTurn = toPrompt([{ role: 'user', content: 'hi' }], { declaredTools: tools, toolsActive: false });
  check('a single user turn passes through untouched', singleTurn === 'hi', singleTurn);

  const disabled = toPrompt(
    [
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: 'It is sunny.' },
      { role: 'user', content: 'And tomorrow?' }
    ],
    { declaredTools: tools, toolsActive: false }
  );
  check('a disabled bridge explains itself in multi-turn prompts', disabled.includes('tool bridging is disabled'));

  const byId = toPrompt(
    [
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":21}' }
    ],
    { declaredTools: tools, toolsActive: true }
  );
  check('standard tool results are labelled via tool_call_id', byId.includes('Tool result (get_weather): {"tempC":21}'), byId);

  process.stdout.write('\nextractAnswer\n');
  const chunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  check('chunks of one message are concatenated', extractAnswer([chunk('Hel'), chunk('lo')]) === 'Hello');
  check(
    'messages split by a tool call stay separate',
    extractAnswer([chunk('Checking.'), { sessionUpdate: 'tool_call', toolCallId: 't1' }, chunk('Done.')]) === 'Checking.\n\nDone.'
  );
  check('no assistant text means no answer', extractAnswer([{ sessionUpdate: 'tool_call' }]) === null);

  process.stdout.write('\njobPhase\n');
  check('settled=true is finished', jobPhase({ state: 'done', settled: true }) === 'finished');
  check('done while the model is still active is not finished', jobPhase({ state: 'done', settled: false }) === 'running');
  check('blocked waits for input', jobPhase({ state: 'blocked', settled: false }) === 'blocked');
  check('state alone is honoured on older services', jobPhase({ state: 'failed' }) === 'finished');
}

// ------------------------------------------------------- integration: gateway

async function integrationTests() {
  const stub = await startStubUpstream();
  const stubUrl = `http://127.0.0.1:${stub.port}`;
  ensureDir(DATA_DIR);

  const makeGateway = async (port, toolsMode, overrides = {}) => {
    const config = loadConfig({
      configPath: path.join(DATA_DIR, 'bridge-config.json'),
      argv: {
        host: '127.0.0.1',
        port,
        accessCode: ACCESS_CODE,
        dataDir: DATA_DIR,
        upstreamUrl: stubUrl,
        logLevel: 'error'
      }
    });
    const store = new JsonStore(path.join(DATA_DIR, `bridge-state-${port}.json`), {
      clients: {},
      refreshTokens: {},
      revoked: {},
      consents: []
    });
    const tokens = new TokenService({
      secret: loadOrCreateKey(path.join(DATA_DIR, 'secret.key')),
      issuer: config.publicUrl,
      accessTokenTtl: config.accessTokenTtl,
      refreshTokenTtl: config.refreshTokenTtl,
      store
    });
    const ctx = createServer({ ...config, openai: { ...config.openai, toolsMode, backendModels: ['gpt-5.5'] }, store, tokens, ...overrides });
    await new Promise((r) => ctx.server.listen(port, '127.0.0.1', r));
    return ctx;
  };

  const PORT_A = 8941;
  const PORT_B = 8942;
  const gateway = await makeGateway(PORT_A, 'translate');
  const ignoreGateway = await makeGateway(PORT_B, 'ignore');
  const base = `http://127.0.0.1:${PORT_A}`;
  const ignoreBase = `http://127.0.0.1:${PORT_B}`;

  try {
    const token = await obtainToken(base, 'agent:read agent:run');
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const post = (url, body, headers = auth) =>
      fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });

    process.stdout.write('\n/v1/tools\n');
    const toolsRes = await fetch(`${base}/v1/tools`, { headers: { Authorization: `Bearer ${token}` } });
    const toolsBody = await toolsRes.json();
    const names = toolsBody.data.map((t) => t.function.name);
    check('/v1/tools lists the MCP catalog', toolsRes.status === 200 && names.includes('agent_run'), names.join(','));
    check('entries are OpenAI function schemas', toolsBody.data[0].type === 'function' && toolsBody.data[0].function.parameters.type === 'object');
    check('/v1/tools advertises the MCP endpoint', toolsBody.mcpEndpoint === `${base}/mcp`);

    process.stdout.write('\ntext replies\n');
    stub.state.answer = 'Seoul is sunny today.';
    const textRes = await post(base, {
      model: 'workbuddy',
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [WEATHER_TOOL],
      tool_choice: 'auto'
    });
    const textBody = await textRes.json();
    check('plain answers pass through unchanged', textBody.choices[0].message.content === 'Seoul is sunny today.');
    check('plain answers finish with stop', textBody.choices[0].finish_reason === 'stop');
    check('no tool_calls on a plain answer', textBody.choices[0].message.tool_calls === undefined);
    check('the tool protocol reached the agent', stub.state.prompts.at(-1).includes('wb_tool_call'));

    process.stdout.write('\ntool call replies\n');
    stub.state.answer = envelope('get_weather', { city: 'Seoul' });
    const callRes = await post(base, {
      model: 'workbuddy',
      messages: [{ role: 'user', content: 'Weather in Seoul?' }],
      tools: [WEATHER_TOOL],
      tool_choice: 'auto'
    });
    const callBody = await callRes.json();
    const choice = callBody.choices[0];
    check('finish_reason becomes tool_calls', choice.finish_reason === 'tool_calls', String(choice.finish_reason));
    check('message.content is null', choice.message.content === null);
    check('tool_calls is present', Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length === 1);
    check('tool call has an id', /^call_/.test(choice.message.tool_calls[0].id), choice.message.tool_calls[0].id);
    check('tool call type is function', choice.message.tool_calls[0].type === 'function');
    check('tool name round-trips', choice.message.tool_calls[0].function.name === 'get_weather');
    check(
      'arguments round-trip as a JSON string',
      JSON.parse(choice.message.tool_calls[0].function.arguments).city === 'Seoul',
      choice.message.tool_calls[0].function.arguments
    );

    process.stdout.write('\nsafety: undeclared tools\n');
    stub.state.answer = envelope('delete_everything', { path: '/' });
    const rogueRes = await post(base, {
      model: 'workbuddy',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
      tool_choice: 'auto'
    });
    const rogueBody = await rogueRes.json();
    check('an undeclared tool is not surfaced as a call', rogueBody.choices[0].message.tool_calls === undefined);
    check('it is returned as text instead', rogueBody.choices[0].finish_reason === 'stop');

    process.stdout.write('\ntool_choice handling\n');
    stub.state.answer = envelope('get_weather', { city: 'Seoul' });
    const noneRes = await post(base, {
      model: 'workbuddy',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
      tool_choice: 'none'
    });
    const noneBody = await noneRes.json();
    check('tool_choice=none disables bridging', noneBody.choices[0].finish_reason === 'stop' && !noneBody.choices[0].message.tool_calls);
    check('tool_choice=none omits the protocol', !stub.state.prompts.at(-1).includes('wb_tool_call'));

    stub.state.answer = envelope('get_weather', { city: 'Seoul' });
    await post(base, {
      model: 'workbuddy',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'function', function: { name: 'get_weather' } }
    });
    check('a forced tool_choice is expressed to the agent', stub.state.prompts.at(-1).includes('You must call "get_weather" now.'));

    process.stdout.write('\nstreaming with tools\n');
    stub.state.answer = envelope('get_weather', { city: 'Seoul' });
    const streamRes = await post(base, {
      model: 'workbuddy',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
      tool_choice: 'auto'
    });
    const streamText = await streamRes.text();
    const chunks = streamText
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)));
    const callChunk = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    check('streaming emits a tool_calls delta', Boolean(callChunk));
    check('streamed tool name is correct', callChunk?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'get_weather');
    check(
      'streamed finish_reason is tool_calls',
      chunks.some((c) => c.choices?.[0]?.finish_reason === 'tool_calls')
    );
    check('the raw envelope is not leaked as content', !streamText.includes('"wb_tool_call"'));
    check('stream still terminates with [DONE]', streamText.trimEnd().endsWith('data: [DONE]'));

    stub.state.answer = 'Just text, no tools.';
    const textStreamRes = await post(base, {
      model: 'workbuddy',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
      tool_choice: 'auto'
    });
    const textStreamText = await textStreamRes.text();
    const textChunks = textStreamText
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)));
    check(
      'a text answer still streams as content',
      textChunks.map((c) => c.choices?.[0]?.delta?.content || '').join('') === 'Just text, no tools.'
    );
    check('no tool_calls delta for a text answer', !textStreamText.includes('"tool_calls"'));

    process.stdout.write('\ntoolsMode=ignore\n');
    const ignoreToken = await obtainToken(ignoreBase, 'agent:read agent:run');
    stub.state.answer = envelope('get_weather', { city: 'Seoul' });
    const ignoreRes = await post(
      ignoreBase,
      {
        model: 'workbuddy',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [WEATHER_TOOL],
        tool_choice: 'auto'
      },
      { 'Content-Type': 'application/json', Authorization: `Bearer ${ignoreToken}` }
    );
    const ignoreBody = await ignoreRes.json();
    check('ignore mode returns the envelope as text', ignoreBody.choices[0].message.content.includes('wb_tool_call'));
    check('ignore mode never returns tool_calls', ignoreBody.choices[0].message.tool_calls === undefined);
    check('ignore mode flags the header', ignoreRes.headers.get('x-workbuddy-tools-ignored') === '1');

    process.stdout.write('\nupstream job contract\n');
    stub.state.answer = 'ok';
    await post(ignoreBase, {
      model: 'workbuddy',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
      workbuddy: { permissionMode: 'acceptEdits' }
    }, { 'Content-Type': 'application/json', Authorization: `Bearer ${ignoreToken}` });
    const sent = stub.state.dispatches.at(-1);
    check('permissionMode and reasoning_effort reach the dispatch', sent.permissionMode === 'acceptEdits' && sent.effort === 'high', JSON.stringify(sent));
    check('a plain pseudo-model dispatches without a backend model', sent.model === undefined, JSON.stringify(sent));

    const ignoreHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ignoreToken}` };
    await post(ignoreBase, { model: 'workbuddy', messages: [{ role: 'user', content: 'hi' }] }, ignoreHeaders);
    const defaulted = stub.state.dispatches.at(-1);
    check('a request without workbuddy.permissionMode dispatches the non-prompting gateway default', defaulted.permissionMode === 'dontAsk', JSON.stringify(defaulted));
    const listed = await (await fetch(`${ignoreBase}/v1/models`, { headers: ignoreHeaders })).json();
    const ids = listed.data.map((m) => m.id);
    check('configured backend models are listed per pseudo-model', ids.includes('workbuddy:gpt-5.5') && ids.includes('workbuddy-ptc:gpt-5.5'), ids.join(','));

    await post(ignoreBase, { model: 'workbuddy-ptc:gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }, ignoreHeaders);
    const viaId = stub.state.dispatches.at(-1);
    check('a backend model id selects the agent and the backend model', viaId.model === 'gpt-5.5' && viaId.agent === 'ptc', JSON.stringify(viaId));

    await post(ignoreBase, { model: 'workbuddy:not-configured', messages: [{ role: 'user', content: 'hi' }] }, ignoreHeaders);
    const unlisted = stub.state.dispatches.at(-1);
    check('an unconfigured backend model is not forwarded', unlisted.model === undefined, JSON.stringify(unlisted));

    const badMode = await post(ignoreBase, {
      model: 'workbuddy',
      messages: [{ role: 'user', content: 'hi' }],
      workbuddy: { permissionMode: 'delegate' }
    }, { 'Content-Type': 'application/json', Authorization: `Bearer ${ignoreToken}` });
    check('an unsupported permissionMode is a 400, not a dispatch', badMode.status === 400);

    const unknownForced = await post(base, {
      model: 'workbuddy',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'function', function: { name: 'not_declared' } }
    });
    check('tool_choice naming an undeclared tool is a 400', unknownForced.status === 400);

    stub.state.calls.length = 0;
    stub.state.answer = '';
    stub.state.job = { state: 'blocked', settled: false, detail: 'Allow Bash(rm -rf build)?' };
    const blockedRes = await post(ignoreBase, {
      model: 'workbuddy',
      messages: [{ role: 'user', content: 'clean the build' }]
    }, { 'Content-Type': 'application/json', Authorization: `Bearer ${ignoreToken}` });
    const blockedBody = await blockedRes.json();
    check('a job blocked on a prompt returns agent_needs_input', blockedRes.status === 409 && blockedBody.error?.code === 'agent_needs_input', JSON.stringify(blockedBody));
    check('the blocked job is stopped, not leaked', stub.state.calls.some((c) => /\/stop$/.test(c.path)));

    stub.state.calls.length = 0;
    stub.state.job = { state: 'done', settled: true };
    await post(ignoreBase, { model: 'workbuddy', messages: [{ role: 'user', content: 'hi' }] }, { 'Content-Type': 'application/json', Authorization: `Bearer ${ignoreToken}` });
    check('a settled job is not stopped', !stub.state.calls.some((c) => /\/stop$/.test(c.path)));

    const mcp = (tokenValue, id, name, args) =>
      fetch(`${ignoreBase}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${tokenValue}` },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
      }).then((r) => r.json());
    await mcp(ignoreToken, 1, 'agent_job_reply', { jobId: 'stub-1', message: 'yes' });
    const reply = stub.state.calls.find((c) => /\/reply$/.test(c.path));
    check('agent_job_reply sends the documented {text} body', reply?.body?.text === 'yes', JSON.stringify(reply?.body));

    stub.state.job = { state: 'blocked', settled: false, detail: 'Which branch?' };
    stub.state.answer = 'Which branch?';
    const blockedRun = await mcp(ignoreToken, 2, 'agent_run', { prompt: 'deploy', timeoutSeconds: 5 });
    check('agent_run returns needsReply for a blocked job', blockedRun.result?.structuredContent?.needsReply === true, JSON.stringify(blockedRun.result?.structuredContent));
    stub.state.job = { state: 'done', settled: true };

    process.stdout.write('\nACP scope and host guard\n');
    const readOnly = await obtainToken(ignoreBase, 'agent:read');
    const acpRo = await fetch(`${ignoreBase}/acp/connect`, { method: 'POST', headers: { Authorization: `Bearer ${readOnly}` } });
    check('a read-only token cannot use ACP', acpRo.status === 403, `got ${acpRo.status}`);
    const acpRun = await fetch(`${ignoreBase}/acp/connect`, { method: 'POST', headers: { Authorization: `Bearer ${ignoreToken}` } });
    check('an agent:run token can use ACP', acpRun.status === 200, `got ${acpRun.status}`);

    const rebound = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: PORT_B, path: '/register', method: 'POST', headers: { Host: 'attacker.example:8942', 'Content-Type': 'application/json' } }, resolve);
      r.on('error', reject);
      r.end(JSON.stringify({ redirect_uris: ['http://attacker.example/cb'] }));
    });
    rebound.resume();
    check('a foreign Host header is refused (DNS rebinding)', rebound.statusCode === 421, `got ${rebound.statusCode}`);

    process.stdout.write('\nno access code\n');
    const locked = await makeGateway(8943, 'ignore', { accessCode: null });
    try {
      const lockedBase = 'http://127.0.0.1:8943';
      const reg = await (await fetch(`${lockedBase}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT] })
      })).json();
      const page = await fetch(`${lockedBase}/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=x`);
      check('without an accessCode the consent page is disabled', page.status === 503, `got ${page.status}`);
      const approve = await fetch(`${lockedBase}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'x', decision: 'allow' }).toString(),
        redirect: 'manual'
      });
      check('without an accessCode no code is issued', approve.status === 503 && !approve.headers.get('location'), `got ${approve.status}`);
    } finally {
      locked.server.close();
    }
  } finally {
    gateway.server.close();
    ignoreGateway.server.close();
    stub.server.close();
  }
}

async function main() {
  unitTests();
  await integrationTests();
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`\ntool bridge test crashed: ${err.stack}\n`);
  process.exit(1);
});
