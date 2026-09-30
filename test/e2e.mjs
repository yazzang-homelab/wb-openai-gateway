#!/usr/bin/env node
/**
 * End-to-end test: exercises the full OAuth + MCP path against a real gateway
 * process wired to the local agent service.
 *
 *   node test/e2e.mjs [--upstream http://127.0.0.1:8399] [--port 8932]
 *
 * Exits non-zero on the first failed assertion.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { JsonStore, ensureDir, loadOrCreateKey } from '../src/store.js';
import { TokenService } from '../src/tokens.js';
import { createServer, makeLogger } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

const UPSTREAM = arg('--upstream', 'http://127.0.0.1:8399');
const PORT = Number(arg('--port', '8932'));
const ACCESS_CODE = 'test-approval-code';
const DATA_DIR = path.join(here, '..', '.testdata');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}\n`);
  }
}

const b64u = (b) => Buffer.from(b).toString('base64url');

function pkce() {
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Register + approve + exchange, returning an access token. */
async function authorizeClient(base, { name, redirect, scope }) {
  const reg = await (
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        scope
      })
    })
  ).json();

  const { verifier, challenge } = pkce();
  const approve = await fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: redirect,
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
        redirect_uri: redirect,
        client_id: reg.client_id,
        code_verifier: verifier
      }).toString()
    })
  ).json();
  return tok.access_token;
}

async function main() {
  ensureDir(DATA_DIR);
  const config = loadConfig({
    configPath: path.join(DATA_DIR, 'test-config.json'),
    argv: {
      host: '127.0.0.1',
      port: PORT,
      accessCode: ACCESS_CODE,
      dataDir: DATA_DIR,
      upstreamUrl: UPSTREAM,
      logLevel: 'warn'
    }
  });
  const store = new JsonStore(path.join(config.dataDir, 'state.json'), {
    clients: {},
    refreshTokens: {},
    revoked: {},
    consents: []
  });
  store.data.clients = {};
  store.data.refreshTokens = {};
  store.data.revoked = {};
  store.save();

  const tokens = new TokenService({
    secret: loadOrCreateKey(path.join(config.dataDir, 'secret.key')),
    issuer: config.publicUrl,
    accessTokenTtl: config.accessTokenTtl,
    refreshTokenTtl: config.refreshTokenTtl,
    store
  });

  const { server } = createServer({ ...config, store, tokens });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = `http://127.0.0.1:${PORT}`;
  process.stdout.write(`\ngateway up on ${base} (upstream ${UPSTREAM})\n\n`);

  try {
    // ---------------------------------------------------------- discovery
    process.stdout.write('discovery\n');
    const prmRes = await fetch(`${base}/.well-known/oauth-protected-resource`);
    const prm = await prmRes.json();
    check('protected resource metadata 200', prmRes.status === 200);
    check('resource points at /mcp', prm.resource === `${base}/mcp`, prm.resource);
    check('authorization server listed', prm.authorization_servers?.[0] === base);

    const prmPathRes = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    check('path-suffixed resource metadata', prmPathRes.status === 200);

    const asRes = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const as = await asRes.json();
    check('AS metadata 200', asRes.status === 200);
    check('PKCE S256 advertised', as.code_challenge_methods_supported?.includes('S256'));
    check('DCR advertised', typeof as.registration_endpoint === 'string');

    // ------------------------------------------------- unauthenticated /mcp
    process.stdout.write('\nunauthenticated MCP access\n');
    const unauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    const challenge = unauth.headers.get('www-authenticate') || '';
    check('401 without token', unauth.status === 401, `got ${unauth.status}`);
    check('WWW-Authenticate carries resource_metadata', challenge.includes('resource_metadata='), challenge);

    // ------------------------------------------------------------- DCR
    process.stdout.write('\ndynamic client registration\n');
    const regRes = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-test-agent',
        redirect_uris: ['http://127.0.0.1:7788/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'agent:read agent:run'
      })
    });
    const reg = await regRes.json();
    check('registration returns 201', regRes.status === 201, JSON.stringify(reg));
    check('client_id issued', typeof reg.client_id === 'string' && reg.client_id.startsWith('wb_'));
    check('no secret for public client', reg.client_secret === undefined);

    const readOnlyRes = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-readonly-agent',
        redirect_uris: ['http://127.0.0.1:7789/callback'],
        token_endpoint_auth_method: 'none',
        scope: 'agent:read'
      })
    });
    const readOnlyClient = await readOnlyRes.json();

    const badRedirect = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'bad', redirect_uris: [] })
    });
    check('empty redirect_uris rejected', badRedirect.status === 400);

    // -------------------------------------------------------- authorization
    process.stdout.write('\nauthorization code + PKCE\n');
    const { verifier, challenge: codeChallenge } = pkce();
    const authUrl = new URL(`${base}/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', reg.client_id);
    authUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:7788/callback');
    authUrl.searchParams.set('scope', 'agent:read agent:run');
    authUrl.searchParams.set('state', 'xyz-state');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('resource', `${base}/mcp`);

    const consent = await fetch(authUrl);
    const consentHtml = await consent.text();
    check('consent page renders', consent.status === 200 && consentHtml.includes('Authorize access'));
    check('consent page names the client', consentHtml.includes('e2e-test-agent'));

    const wrongCode = await fetch(`${base}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: reg.client_id,
        redirect_uri: 'http://127.0.0.1:7788/callback',
        scope: 'agent:read agent:run',
        state: 'xyz-state',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        decision: 'allow',
        access_code: 'wrong-code'
      }).toString(),
      redirect: 'manual'
    });
    check('wrong passphrase rejected', wrongCode.status === 401, `got ${wrongCode.status}`);

    const approve = await fetch(`${base}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: reg.client_id,
        redirect_uri: 'http://127.0.0.1:7788/callback',
        scope: 'agent:read agent:run',
        state: 'xyz-state',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        resource: `${base}/mcp`,
        decision: 'allow',
        access_code: ACCESS_CODE
      }).toString(),
      redirect: 'manual'
    });
    const location = approve.headers.get('location') || '';
    check('approval redirects', approve.status === 302, `got ${approve.status}`);
    const code = new URL(location).searchParams.get('code');
    check('authorization code returned', Boolean(code));
    check('state echoed back', new URL(location).searchParams.get('state') === 'xyz-state');

    // ----------------------------------------------------------- token
    process.stdout.write('\ntoken endpoint\n');
    const badPkce = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:7788/callback',
        client_id: reg.client_id,
        code_verifier: 'not-the-right-verifier'
      }).toString()
    });
    check('PKCE mismatch rejected', badPkce.status === 400);

    const tokenRes = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:7788/callback',
        client_id: reg.client_id,
        code_verifier: verifier
      }).toString()
    });
    const tok = await tokenRes.json();
    check('token issued', tokenRes.status === 200 && Boolean(tok.access_token), JSON.stringify(tok));
    check('token_type is Bearer', tok.token_type === 'Bearer');
    check('refresh token issued', typeof tok.refresh_token === 'string');
    check('scope granted', tok.scope === 'agent:read agent:run', tok.scope);

    const replay = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://127.0.0.1:7788/callback',
        client_id: reg.client_id,
        code_verifier: verifier
      }).toString()
    });
    check('authorization code is single-use', replay.status === 400);

    // ------------------------------------------------------------- MCP
    process.stdout.write('\nMCP over streamable HTTP\n');
    const authHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${tok.access_token}`
    };

    const initRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-test-agent', version: '1.0.0' }
        }
      })
    });
    const sessionId = initRes.headers.get('mcp-session-id');
    const initBody = await initRes.json();
    check('initialize returns 200', initRes.status === 200);
    check('session id assigned', Boolean(sessionId));
    check('protocol version echoed', initBody.result?.protocolVersion === '2025-06-18');
    check('server identifies itself', initBody.result?.serverInfo?.name === 'wb-agent-gateway');

    const listRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders, 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    const list = await listRes.json();
    const toolNames = (list.result?.tools || []).map((t) => t.name);
    check('tools/list returns tools', toolNames.length > 0, toolNames.join(','));
    check('agent_run exposed', toolNames.includes('agent_run'));
    check('every tool has an inputSchema', (list.result?.tools || []).every((t) => t.inputSchema?.type === 'object'));

    const healthCall = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders, 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'agent_health', arguments: {} }
      })
    });
    const health = await healthCall.json();
    const healthText = health.result?.content?.[0]?.text || '';
    check('agent_health proxies upstream', healthText.includes('"status": "ok"'), healthText.slice(0, 120));
    check('structuredContent present', Boolean(health.result?.structuredContent));

    const unknownTool = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders, 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} }
      })
    });
    const unknown = await unknownTool.json();
    check('unknown tool -> JSON-RPC error', unknown.error?.code === -32602, JSON.stringify(unknown));

    const badMethod = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders, 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'nope/nope' })
    });
    const badMethodBody = await badMethod.json();
    check('unknown method -> -32601', badMethodBody.error?.code === -32601);

    const sseRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders, 'Mcp-Session-Id': sessionId, Accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' })
    });
    const sseBody = await sseRes.text();
    check('SSE transport when only text/event-stream accepted', sseRes.headers.get('content-type')?.includes('text/event-stream'));
    check('SSE frame contains the response', sseBody.includes('"id":6'), sseBody.slice(0, 120));

    // ------------------------------------------------- scope enforcement
    process.stdout.write('\nscope enforcement\n');
    const { verifier: v2, challenge: c2 } = pkce();
    const authUrl2 = new URL(`${base}/authorize`);
    authUrl2.searchParams.set('response_type', 'code');
    authUrl2.searchParams.set('client_id', readOnlyClient.client_id);
    authUrl2.searchParams.set('redirect_uri', 'http://127.0.0.1:7789/callback');
    authUrl2.searchParams.set('scope', 'agent:read');
    authUrl2.searchParams.set('code_challenge', c2);
    authUrl2.searchParams.set('code_challenge_method', 'S256');
    await fetch(authUrl2);
    const approve2 = await fetch(`${base}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: readOnlyClient.client_id,
        redirect_uri: 'http://127.0.0.1:7789/callback',
        scope: 'agent:read',
        code_challenge: c2,
        code_challenge_method: 'S256',
        decision: 'allow',
        access_code: ACCESS_CODE
      }).toString(),
      redirect: 'manual'
    });
    const code2 = new URL(approve2.headers.get('location')).searchParams.get('code');
    const tok2Res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: 'http://127.0.0.1:7789/callback',
        client_id: readOnlyClient.client_id,
        code_verifier: v2
      }).toString()
    });
    const tok2 = await tok2Res.json();
    check('read-only token issued', Boolean(tok2.access_token));

    const roList = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders, Authorization: `Bearer ${tok2.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
    });
    const roListBody = await roList.json();
    const roTools = (roListBody.result?.tools || []).map((t) => t.name);
    check('read-only token cannot see agent_run', !roTools.includes('agent_run'), roTools.join(','));

    const roCall = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders, Authorization: `Bearer ${tok2.access_token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'agent_run', arguments: { prompt: 'should not run' } }
      })
    });
    const roCallBody = await roCall.json();
    check(
      'read-only token denied agent_run',
      roCallBody.result?.isError === true && /Permission denied/.test(roCallBody.result?.content?.[0]?.text || '')
    );

    // A run-only token must not be able to read the catalog, including the
    // single-model route (a path-prefix check, not an exact match).
    const runOnlyToken = await authorizeClient(base, {
      name: 'e2e-runonly-agent',
      redirect: 'http://127.0.0.1:7790/callback',
      scope: 'agent:run'
    });
    const runOnlyHeaders = { Authorization: `Bearer ${runOnlyToken}` };

    const roModelsList = await fetch(`${base}/v1/models`, { headers: runOnlyHeaders });
    check('run-only token cannot list models', roModelsList.status === 403, `got ${roModelsList.status}`);

    const roModelsOne = await fetch(`${base}/v1/models/workbuddy`, { headers: runOnlyHeaders });
    check('run-only token cannot read a single model', roModelsOne.status === 403, `got ${roModelsOne.status}`);

    const runOnlyTools = await fetch(`${base}/v1/tools`, { headers: runOnlyHeaders });
    check('run-only token cannot list tools', runOnlyTools.status === 403, `got ${runOnlyTools.status}`);

    const runOnlyChat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...runOnlyHeaders },
      body: JSON.stringify({
        model: 'workbuddy',
        messages: [{ role: 'user', content: 'hi' }],
        workbuddy: { timeoutSeconds: 5 }
      })
    });
    check('run-only token can still run completions', runOnlyChat.status === 200, `got ${runOnlyChat.status}`);

    // ------------------------------------------------- OpenAI compatibility
    process.stdout.write('\nOpenAI-compatible surface\n');

    const noTokenModels = await fetch(`${base}/v1/models`);
    check('/v1/models requires a token', noTokenModels.status === 401, `got ${noTokenModels.status}`);

    const modelsRes = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    const models = await modelsRes.json();
    const modelIds = (models.data || []).map((m) => m.id);
    check('/v1/models returns a list', modelsRes.status === 200 && models.object === 'list');
    check('default model advertised', modelIds.includes('workbuddy'), modelIds.join(','));

    const oneModel = await fetch(`${base}/v1/models/workbuddy`, {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    const oneModelBody = await oneModel.json();
    check('/v1/models/:id works', oneModelBody.id === 'workbuddy' && oneModelBody.object === 'model');

    const roModels = await fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${tok2.access_token}` }
    });
    check('read-only token can list models', roModels.status === 200, `got ${roModels.status}`);

    const noMessages = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({ model: 'workbuddy', messages: [] })
    });
    const noMessagesBody = await noMessages.json();
    check('missing messages -> 400 in OpenAI error shape', noMessages.status === 400 && Boolean(noMessagesBody.error?.message));

    const roChat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok2.access_token}` },
      body: JSON.stringify({ model: 'workbuddy', messages: [{ role: 'user', content: 'hi' }] })
    });
    const roChatBody = await roChat.json();
    check(
      'read-only token cannot run chat completions',
      roChat.status === 403 && roChatBody.error?.code === 'insufficient_scope',
      `${roChat.status} ${JSON.stringify(roChatBody).slice(0, 120)}`
    );

    // Short timeout keeps these deterministic whether or not the agent is signed in.
    const chatRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({
        model: 'workbuddy',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'Say the single word PONG.' }
        ],
        workbuddy: { timeoutSeconds: 5 }
      })
    });
    const chat = await chatRes.json();
    check('non-streaming completion returns 200', chatRes.status === 200, JSON.stringify(chat).slice(0, 200));
    check('object is chat.completion', chat.object === 'chat.completion');
    check('id is chatcmpl-*', typeof chat.id === 'string' && chat.id.startsWith('chatcmpl-'));
    check('model echoed back', chat.model === 'workbuddy');
    check('choice has an assistant message', chat.choices?.[0]?.message?.role === 'assistant');
    check('content is a string', typeof chat.choices?.[0]?.message?.content === 'string');
    check(
      'finish_reason is stop or length',
      ['stop', 'length'].includes(chat.choices?.[0]?.finish_reason),
      String(chat.choices?.[0]?.finish_reason)
    );
    check('usage is reported', typeof chat.usage?.total_tokens === 'number');
    check('job id exposed in a header', Boolean(chatRes.headers.get('x-workbuddy-job-id')));

    const legacyRes = await fetch(`${base}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({ model: 'workbuddy', prompt: 'Say PONG.', workbuddy: { timeoutSeconds: 5 } })
    });
    const legacy = await legacyRes.json();
    check('legacy /v1/completions works', legacyRes.status === 200 && legacy.object === 'text_completion');
    check('legacy choice has text', typeof legacy.choices?.[0]?.text === 'string');

    const streamRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({
        model: 'workbuddy',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'Say PONG.' }],
        workbuddy: { timeoutSeconds: 5 }
      })
    });
    const streamText = await streamRes.text();
    check('streaming sets text/event-stream', streamRes.headers.get('content-type')?.includes('text/event-stream'));
    check('stream terminates with [DONE]', streamText.trimEnd().endsWith('data: [DONE]'));
    const streamChunks = streamText
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(6)));
    check('at least one chunk emitted', streamChunks.length >= 1, `${streamChunks.length} chunks`);
    check('first chunk opens the assistant role', streamChunks[0]?.choices?.[0]?.delta?.role === 'assistant');
    check('chunks are chat.completion.chunk', streamChunks[0]?.object === 'chat.completion.chunk');
    const finishChunk = streamChunks.find((c) => c.choices?.[0]?.finish_reason);
    check(
      'a final chunk carries finish_reason',
      ['stop', 'length'].includes(finishChunk?.choices?.[0]?.finish_reason),
      String(finishChunk?.choices?.[0]?.finish_reason)
    );
    check(
      'include_usage emits a usage-only chunk',
      streamChunks.some((c) => Array.isArray(c.choices) && c.choices.length === 0 && c.usage)
    );

    const unknownModel = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        workbuddy: { timeoutSeconds: 5 }
      })
    });
    const unknownModelBody = await unknownModel.json();
    check(
      'unknown model falls back to the default agent and echoes the id',
      unknownModel.status === 200 && unknownModelBody.model === 'gpt-4o-mini',
      `${unknownModel.status} ${unknownModelBody.model}`
    );

    // ------------------------------------------- OpenAI function calling
    process.stdout.write('\nOpenAI tools handling\n');
    const toolDefs = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
        }
      }
    ];

    const toolsRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({
        model: 'workbuddy',
        messages: [{ role: 'user', content: 'What is the weather in Seoul?' }],
        tools: toolDefs,
        tool_choice: 'auto',
        workbuddy: { timeoutSeconds: 5 }
      })
    });
    const toolsBody = await toolsRes.json();
    check('declaring tools is accepted in ignore mode', toolsRes.status === 200, `got ${toolsRes.status}`);
    check('ignored tools are flagged in a header', toolsRes.headers.get('x-workbuddy-tools-ignored') === '1');
    check('the header is exposed for browser clients', String(toolsRes.headers.get('access-control-expose-headers') || '').includes('X-WorkBuddy-Tools-Ignored'));
    check('no tool_calls are ever returned', !toolsBody.choices?.[0]?.message?.tool_calls);
    check('finish_reason is never tool_calls', toolsBody.choices?.[0]?.finish_reason !== 'tool_calls');
    check('the tool declaration does not break the answer shape', typeof toolsBody.choices?.[0]?.message?.content === 'string');

    const toolsStream = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({
        model: 'workbuddy',
        stream: true,
        messages: [{ role: 'user', content: 'What is the weather in Seoul?' }],
        tools: toolDefs,
        workbuddy: { timeoutSeconds: 5 }
      })
    });
    const toolsStreamText = await toolsStream.text();
    check('streaming also flags ignored tools', toolsStream.headers.get('x-workbuddy-tools-ignored') === '1');
    check('streamed chunks contain no tool_calls deltas', !toolsStreamText.includes('"tool_calls"'));

    // A second gateway configured to fail fast instead of silently ignoring tools.
    const rejectPort = PORT + 3;
    const rejectServer = createServer({
      ...config,
      openai: { toolsMode: 'reject' },
      store,
      tokens
    });
    await new Promise((r) => rejectServer.server.listen(rejectPort, '127.0.0.1', r));
    try {
      const rejected = await fetch(`http://127.0.0.1:${rejectPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
        body: JSON.stringify({
          model: 'workbuddy',
          messages: [{ role: 'user', content: 'hi' }],
          tools: toolDefs,
          workbuddy: { timeoutSeconds: 5 }
        })
      });
      const rejectedBody = await rejected.json();
      check('toolsMode=reject fails fast', rejected.status === 400, `got ${rejected.status}`);
      check('reject error names the tool', rejectedBody.error?.code === 'tools_not_supported');
      check('reject error is actionable', /MCP endpoint|\/mcp/.test(rejectedBody.error?.message || ''));

      const noTools = await fetch(`http://127.0.0.1:${rejectPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
        body: JSON.stringify({
          model: 'workbuddy',
          messages: [{ role: 'user', content: 'hi' }],
          workbuddy: { timeoutSeconds: 5 }
        })
      });
      check('reject mode still serves tool-free requests', noTools.status === 200, `got ${noTools.status}`);
    } finally {
      rejectServer.server.close();
    }

    // ------------------------------------------------------- refresh + revoke
    process.stdout.write('\nrefresh and revocation\n');
    const refreshRes = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: reg.client_id
      }).toString()
    });
    const refreshed = await refreshRes.json();
    check('refresh_token grant works', refreshRes.status === 200 && Boolean(refreshed.access_token));
    check('refresh rotates the refresh token', refreshed.refresh_token !== tok.refresh_token);

    const reuseRefresh = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tok.refresh_token,
        client_id: reg.client_id
      }).toString()
    });
    check('refresh token is single-use', reuseRefresh.status === 400);

    const revokeRes = await fetch(`${base}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshed.access_token, client_id: reg.client_id }).toString()
    });
    check('revoke returns 200', revokeRes.status === 200);

    const afterRevoke = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...authHeaders, Authorization: `Bearer ${refreshed.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    });
    check('revoked token rejected', afterRevoke.status === 401, `got ${afterRevoke.status}`);

    // ------------------------------------------------------------- health
    process.stdout.write('\ngateway health\n');
    const healthRes = await fetch(`${base}/health`);
    const healthJson = await healthRes.json();
    check('health endpoint', healthRes.status === 200);
    check('upstream reported healthy', healthJson.upstream?.status === 'ok', JSON.stringify(healthJson.upstream));
  } finally {
    server.close();
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`\ntest crashed: ${err.stack}\n`);
  process.exit(1);
});

export { makeLogger };
