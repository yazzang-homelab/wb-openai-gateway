#!/usr/bin/env node
/**
 * Wire-compatibility test using the official `openai` Node SDK.
 *
 * Proves that an unmodified OpenAI client can talk to the gateway: it obtains a
 * token through the OAuth flow, then drives /v1/models, /v1/chat/completions
 * (buffered and streamed) and checks that errors come back in OpenAI's shape.
 *
 *   node test/openai-client.mjs [--upstream http://127.0.0.1:8399] [--port 8934]
 *
 * Requires the optional dev dependency `openai`. Skips (exit 0) when absent.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { JsonStore, ensureDir, loadOrCreateKey } from '../src/store.js';
import { TokenService } from '../src/tokens.js';
import { createServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

const UPSTREAM = arg('--upstream', 'http://127.0.0.1:8399');
const PORT = Number(arg('--port', '8934'));
const ACCESS_CODE = 'openai-sdk-code';
const REDIRECT = 'http://127.0.0.1:7798/callback';

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

let OpenAI;
try {
  ({ default: OpenAI } = await import('openai'));
} catch {
  process.stdout.write(
    'SKIP: the `openai` package is not installed.\n      Run `npm install` to enable this test.\n'
  );
  process.exit(0);
}

const b64u = (b) => Buffer.from(b).toString('base64url');

/** Drive the gateway's own OAuth flow to obtain a bearer token. */
async function obtainToken(base, scope) {
  const reg = await (
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'openai-sdk-test',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        scope
      })
    })
  ).json();

  const verifier = b64u(crypto.randomBytes(32));
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const form = new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    scope,
    state: 's',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    decision: 'allow',
    access_code: ACCESS_CODE
  });
  const approve = await fetch(`${base}/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
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

async function main() {
  const dataDir = path.join(here, '..', '.testdata');
  ensureDir(dataDir);
  const config = loadConfig({
    configPath: path.join(dataDir, 'openai-test-config.json'),
    argv: {
      host: '127.0.0.1',
      port: PORT,
      accessCode: ACCESS_CODE,
      dataDir,
      upstreamUrl: UPSTREAM,
      logLevel: 'warn'
    }
  });
  const store = new JsonStore(path.join(dataDir, 'openai-state.json'), {
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
    secret: loadOrCreateKey(path.join(dataDir, 'secret.key')),
    issuer: config.publicUrl,
    accessTokenTtl: config.accessTokenTtl,
    refreshTokenTtl: config.refreshTokenTtl,
    store
  });

  const { server } = createServer({ ...config, store, tokens });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = `http://127.0.0.1:${PORT}`;
  process.stdout.write(`\nOpenAI SDK test against ${base}/v1\n\n`);

  try {
    const token = await obtainToken(base, 'agent:read agent:run');
    const client = new OpenAI({ baseURL: `${base}/v1`, apiKey: token, maxRetries: 0 });

    process.stdout.write('models\n');
    const models = await client.models.list();
    const ids = models.data.map((m) => m.id);
    check('client.models.list() works', ids.length > 0, ids.join(','));
    check('workbuddy model advertised', ids.includes('workbuddy'));

    process.stdout.write('\nchat completions\n');
    const completion = await client.chat.completions.create({
      model: 'workbuddy',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Say PONG.' }
      ],
      workbuddy: { timeoutSeconds: 5 }
    });
    check('non-streaming call returns a completion', completion.object === 'chat.completion');
    check('choices[0].message.role is assistant', completion.choices[0].message.role === 'assistant');
    check('content is a string', typeof completion.choices[0].message.content === 'string');
    check(
      'finish_reason is stop or length',
      ['stop', 'length'].includes(completion.choices[0].finish_reason),
      String(completion.choices[0].finish_reason)
    );
    check('usage parsed by the SDK', typeof completion.usage?.total_tokens === 'number');

    process.stdout.write('\nstreaming\n');
    const stream = await client.chat.completions.create({
      model: 'workbuddy',
      stream: true,
      messages: [{ role: 'user', content: 'Say PONG.' }],
      workbuddy: { timeoutSeconds: 5 }
    });
    let sawRole = false;
    let sawFinish = null;
    let text = '';
    for await (const chunk of stream) {
      if (chunk.choices?.[0]?.delta?.role === 'assistant') sawRole = true;
      if (chunk.choices?.[0]?.delta?.content) text += chunk.choices[0].delta.content;
      if (chunk.choices?.[0]?.finish_reason) sawFinish = chunk.choices[0].finish_reason;
    }
    check('SDK parsed the SSE stream', true);
    check('first delta announced the assistant role', sawRole);
    check('stream ended with a finish_reason', ['stop', 'length'].includes(sawFinish), String(sawFinish));
    check('accumulated text is a string', typeof text === 'string');

    process.stdout.write('\nerror handling\n');
    const badClient = new OpenAI({ baseURL: `${base}/v1`, apiKey: 'not-a-real-token', maxRetries: 0 });
    let authErr = null;
    try {
      await badClient.chat.completions.create({
        model: 'workbuddy',
        messages: [{ role: 'user', content: 'hi' }],
        workbuddy: { timeoutSeconds: 5 }
      });
    } catch (err) {
      authErr = err;
    }
    check('bad token raises an SDK error', Boolean(authErr), String(authErr));
    check(
      'error carries a 401 status',
      authErr?.status === 401,
      String(authErr?.status)
    );

    const roToken = await obtainToken(base, 'agent:read');
    const roClient = new OpenAI({ baseURL: `${base}/v1`, apiKey: roToken, maxRetries: 0 });
    let scopeErr = null;
    try {
      await roClient.chat.completions.create({
        model: 'workbuddy',
        messages: [{ role: 'user', content: 'hi' }],
        workbuddy: { timeoutSeconds: 5 }
      });
    } catch (err) {
      scopeErr = err;
    }
    check('read-only token is refused', Boolean(scopeErr), String(scopeErr));
    check('refusal is a 403 permission error', scopeErr?.status === 403, String(scopeErr?.status));
  } finally {
    server.close();
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`\nOpenAI SDK test crashed: ${err.stack}\n`);
  process.exit(1);
});
