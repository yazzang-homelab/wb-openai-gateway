#!/usr/bin/env node
/**
 * Wire-compatibility test using the official MCP TypeScript SDK as the client.
 *
 * This drives the real OAuth discovery + PKCE flow that any MCP client performs:
 * connect -> 401 -> discovery -> dynamic registration -> consent -> code ->
 * token -> connect -> tools/list -> tools/call.
 *
 *   node test/mcp-sdk-client.mjs [--upstream http://127.0.0.1:8399] [--port 8933]
 *
 * Requires the optional dev dependency @modelcontextprotocol/sdk.
 * Skips (exit 0) when it is not installed.
 */
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
const PORT = Number(arg('--port', '8933'));
const ACCESS_CODE = 'sdk-test-code';
const REDIRECT = 'http://127.0.0.1:7799/callback';

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

let Client;
let StreamableHTTPClientTransport;
let UnauthorizedError;
try {
  ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
  ({ StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js'));
  ({ UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js'));
} catch {
  process.stdout.write(
    'SKIP: @modelcontextprotocol/sdk is not installed.\n' +
      '      Run `npm install` to enable this test.\n'
  );
  process.exit(0);
}

/** Minimal in-memory OAuthClientProvider, the same shape a real client implements. */
class TestOAuthProvider {
  constructor() {
    this.savedClient = undefined;
    this.savedTokens = undefined;
    this.verifier = undefined;
    this.authorizationUrl = undefined;
    this.redirectCount = 0;
  }

  get redirectUrl() {
    return REDIRECT;
  }

  get clientMetadata() {
    return {
      redirect_uris: [REDIRECT],
      client_name: 'sdk-wire-test',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'agent:read agent:run'
    };
  }

  state() {
    return 'sdk-state-1234';
  }

  clientInformation() {
    return this.savedClient;
  }

  saveClientInformation(info) {
    this.savedClient = info;
  }

  tokens() {
    return this.savedTokens;
  }

  saveTokens(tokens) {
    this.savedTokens = tokens;
  }

  async redirectToAuthorization(url) {
    this.redirectCount++;
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier) {
    this.verifier = verifier;
  }

  codeVerifier() {
    if (!this.verifier) throw new Error('no code verifier saved');
    return this.verifier;
  }
}

async function main() {
  const dataDir = path.join(here, '..', '.testdata');
  ensureDir(dataDir);
  const config = loadConfig({
    configPath: path.join(dataDir, 'sdk-test-config.json'),
    argv: {
      host: '127.0.0.1',
      port: PORT,
      accessCode: ACCESS_CODE,
      dataDir,
      upstreamUrl: UPSTREAM,
      logLevel: 'warn'
    }
  });
  const store = new JsonStore(path.join(dataDir, 'sdk-state.json'), {
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
  process.stdout.write(`\nSDK client test against ${base}/mcp\n\n`);

  const provider = new TestOAuthProvider();
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
  const client = new Client({ name: 'sdk-wire-test', version: '1.0.0' });

  try {
    // 1. First connect must fail with UnauthorizedError and trigger discovery.
    process.stdout.write('oauth handshake (SDK-driven)\n');
    let unauthErr = null;
    try {
      await client.connect(transport);
    } catch (err) {
      unauthErr = err;
    }
    check('connect without a token throws UnauthorizedError', unauthErr instanceof UnauthorizedError, String(unauthErr));
    check('SDK discovered the authorization endpoint', Boolean(provider.authorizationUrl));
    check('SDK registered a client dynamically', Boolean(provider.savedClient?.client_id));
    check('SDK saved a PKCE verifier', Boolean(provider.verifier));

    const authUrl = provider.authorizationUrl;
    check('authorization URL points at our gateway', authUrl?.origin === base, String(authUrl));
    check('authorization URL carries code_challenge', authUrl?.searchParams.get('code_challenge_method') === 'S256');
    check('authorization URL carries the resource indicator', Boolean(authUrl?.searchParams.get('resource')));

    // 2. Render consent and approve it the way a browser would.
    const consent = await fetch(authUrl);
    const html = await consent.text();
    check('consent page served', consent.status === 200 && html.includes('sdk-wire-test'));

    const form = new URLSearchParams();
    for (const key of ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource']) {
      const v = authUrl.searchParams.get(key);
      if (v) form.set(key, v);
    }
    form.set('decision', 'allow');
    form.set('access_code', ACCESS_CODE);

    const approve = await fetch(`${base}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual'
    });
    check('consent approval redirects', approve.status === 302, `got ${approve.status}`);
    const redirected = new URL(approve.headers.get('location'));
    check('redirect goes to the registered callback', `${redirected.origin}${redirected.pathname}` === REDIRECT);
    check('state matches the SDK state', redirected.searchParams.get('state') === 'sdk-state-1234');
    const code = redirected.searchParams.get('code');
    check('authorization code present', Boolean(code));

    // 3. Hand the code back to the SDK; it performs the token exchange itself.
    await transport.finishAuth(code);
    check('SDK stored access + refresh tokens', Boolean(provider.savedTokens?.access_token && provider.savedTokens?.refresh_token));

    // 4. Reconnect with the token.
    const transport2 = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
    const client2 = new Client({ name: 'sdk-wire-test', version: '1.0.0' });
    await client2.connect(transport2);
    check('authenticated connect succeeds', true);
    check('server info received', client2.getServerVersion()?.name === 'wb-agent-gateway', JSON.stringify(client2.getServerVersion()));

    process.stdout.write('\ntools through the SDK\n');
    const listed = await client2.listTools();
    const names = (listed.tools || []).map((t) => t.name);
    check('listTools returns the catalog', names.length >= 8, names.join(','));
    check('agent_run present', names.includes('agent_run'));

    const health = await client2.callTool({ name: 'agent_health', arguments: {} });
    const text = health.content?.[0]?.text || '';
    check('callTool agent_health round-trips', text.includes('"status": "ok"'), text.slice(0, 120));
    check('structuredContent returned', Boolean(health.structuredContent));

    const info = await client2.callTool({ name: 'agent_info', arguments: {} });
    check('callTool agent_info round-trips', (info.content?.[0]?.text || '').includes('"version"'), (info.content?.[0]?.text || '').slice(0, 100));

    const badTool = await client2.callTool({ name: 'nope', arguments: {} }).catch((e) => ({ error: e }));
    check('unknown tool surfaces an error', Boolean(badTool.error) || badTool.isError === true);

    await transport2.close();
    await transport.close();
  } finally {
    server.close();
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`\nSDK client test crashed: ${err.stack}\n`);
  process.exit(1);
});
