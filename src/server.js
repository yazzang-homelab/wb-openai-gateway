/**
 * HTTP surface of the gateway.
 *
 *   GET  /                     landing page + connection instructions
 *   GET  /health               gateway and upstream health
 *   --- OAuth 2.0 authorization server (see oauth.js) ---
 *   GET  /.well-known/oauth-authorization-server
 *   GET  /.well-known/oauth-protected-resource[/mcp]
 *   POST /register             dynamic client registration
 *   GET  /authorize            consent screen
 *   POST /authorize            consent decision
 *   POST /token                token endpoint
 *   POST /revoke               token revocation
 *   --- MCP resource server (bearer protected) ---
 *   POST /mcp  GET /mcp  DELETE /mcp
 *   --- ACP passthrough (bearer protected) ---
 *   ANY  /acp/*                -> upstream /api/v1/acp/*
 */
import http from 'node:http';
import { OAuthServer, esc, page } from './oauth.js';
import { McpServer } from './mcp.js';
import { Upstream } from './upstream.js';
import { UpstreamSupervisor } from './supervisor.js';
import { OpenAiCompat } from './openai.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function makeLogger(level = 'info') {
  const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const threshold = levels[level] ?? 3;
  const emit = (lvl, args) => {
    if (levels[lvl] > threshold) return;
    const stamp = new Date().toISOString();
    // eslint-disable-next-line no-console
    console[lvl === 'debug' ? 'log' : lvl](`${stamp} [${lvl}]`, ...args);
  };
  return {
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a)
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  // Unknown content type: try JSON, fall back to raw string.
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"
  });
  res.end(html);
}

export function createServer(config) {
  const log = makeLogger(config.logLevel);
  const store = config.store;
  const tokens = config.tokens;
  const upstream = new Upstream(config.upstream);
  const supervisor = new UpstreamSupervisor({ config, upstream, log });
  const oauth = new OAuthServer({ config, store, tokens, log });
  const mcp = new McpServer({ config, upstream, supervisor, log });
  const openai = new OpenAiCompat({ config, upstream, supervisor, log });

  const helpers = { sendJson, sendHtml, readBody, log };
  const publicHost = new URL(config.publicUrl).host.toLowerCase();

  const server = http.createServer(async (req, res) => {
    // DNS-rebinding guard: a hostile page that rebinds its own name to
    // 127.0.0.1 still sends its own name as Host.
    if (!hostAllowed(req, publicHost)) {
      sendJson(res, 421, {
        error: 'invalid_host',
        error_description: `Host "${req.headers.host || ''}" is not served here. Use ${config.publicUrl} or set publicUrl.`
      });
      return;
    }

    const url = new URL(req.url, config.publicUrl);
    const path = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Accept, Last-Event-ID',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }

    try {
      if (path === '/' && req.method === 'GET') {
        sendHtml(res, 200, landingPage(config));
        return;
      }

      if (path === '/health' && req.method === 'GET') {
        let upstreamHealth = null;
        let upstreamError = null;
        try {
          upstreamHealth = await upstream.health();
        } catch (err) {
          upstreamError = err.message;
        }
        const status = upstreamError ? null : await supervisor.status();
        sendJson(res, 200, {
          gateway: { status: 'ok', version: '1.0.0', issuer: oauth.issuer },
          upstream: upstreamError
            ? { status: 'unreachable', error: upstreamError }
            : {
                status: 'ok',
                ...upstreamHealth,
                // Whether the gateway password we hold was accepted.
                credentialAccepted: status?.credentials?.authenticated ?? null,
                // Whether the agent is signed in to an account (empty userName = not signed in).
                signedIn: status?.account?.signedIn ?? null,
                userName: status?.account?.userName ?? null,
                ...(status?.account && status.account.signedIn === false
                  ? {
                      hint:
                        'The agent service is reachable but not signed in to a CodeBuddy account, so agent runs ' +
                        'will stay at "starting..." and produce no output. Sign in to CodeBuddy Code, or set ' +
                        'CODEBUDDY_API_KEY and start the gateway with --spawn-upstream.'
                    }
                  : {})
              },
          clients: Object.keys(oauth.clients).length,
          sessions: mcp.sessions.size
        });
        return;
      }

      // ---- OAuth 2.0 authorization server --------------------------------
      if (await oauth.handle(req, res, url, helpers)) return;

      // ---- bearer-protected surfaces -------------------------------------
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        const auth = authenticate(req, res, { tokens, resource: oauth.resource, issuer: oauth.issuer, log });
        if (!auth) return;
        if (req.method === 'POST') return void (await mcp.handlePost(req, res, { auth, ...helpers }));
        if (req.method === 'GET') return void mcp.handleGet(req, res, { auth, ...helpers });
        if (req.method === 'DELETE') return void mcp.handleDelete(req, res, { auth, ...helpers });
        sendJson(res, 405, { error: 'method_not_allowed', error_description: 'Use POST, GET or DELETE.' });
        return;
      }

      if (config.exposeAcp && (path === '/acp' || path.startsWith('/acp/'))) {
        const auth = authenticate(req, res, { tokens, resource: oauth.resource, issuer: oauth.issuer, log });
        if (!auth) return;
        // ACP carries prompts, so it is as powerful as agent_run.
        if (!auth.scopes.includes('agent:run')) {
          sendJson(
            res,
            403,
            {
              error: 'insufficient_scope',
              error_description: `ACP requires the "agent:run" scope; this token has: ${auth.scopes.join(', ') || '(none)'}.`
            },
            { 'WWW-Authenticate': 'Bearer realm="wb-agent-gateway", error="insufficient_scope", scope="agent:run"' }
          );
          return;
        }
        await proxyAcp(req, res, url, upstream, log);
        return;
      }

      // ---- OpenAI-compatible surface (bearer protected) -------------------
      if (path === '/v1' || path.startsWith('/v1/')) {
        const auth = authenticate(req, res, { tokens, resource: oauth.resource, issuer: oauth.issuer, log });
        if (!auth) return;
        if (path === '/v1' && req.method === 'GET') {
          sendJson(res, 200, {
            object: 'list',
            data: [
              { id: 'chat/completions', object: 'endpoint', method: 'POST' },
              { id: 'completions', object: 'endpoint', method: 'POST' },
              { id: 'models', object: 'endpoint', method: 'GET' },
              { id: 'tools', object: 'endpoint', method: 'GET' }
            ]
          });
          return;
        }
        // Reads of the catalog need agent:read; completions need agent:run and
        // are checked inside the OpenAI layer.
        if (
          (path.startsWith('/v1/models') || path.startsWith('/v1/tools')) &&
          !auth.scopes.includes('agent:read')
        ) {
          sendJson(res, 403, {
            error: {
              message: `This token has scopes [${auth.scopes.join(', ')}] but reading models and tools requires "agent:read".`,
              type: 'permission_error',
              param: null,
              code: 'insufficient_scope'
            }
          });
          return;
        }
        if (await openai.handle(req, res, url, helpers, auth)) return;
      }

      sendJson(res, 404, {
        error: 'not_found',
        error_description: `No route for ${req.method} ${path}`,
        hint: `Discovery starts at ${config.publicUrl}/.well-known/oauth-protected-resource`
      });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error('unhandled error', err);
      else log.warn(`request rejected: ${err.message}`);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status >= 500 ? 'server_error' : 'invalid_request',
          error_description: err.message
        });
      } else {
        res.end();
      }
    }
  });

  return { server, log, oauth, mcp, openai, upstream, supervisor, store, tokens };
}

/**
 * Host header values the gateway answers to: publicUrl, plus loopback names on
 * the port the request actually arrived on.
 */
function hostAllowed(req, publicHost) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host === publicHost) return true;
  const port = req.socket.localPort;
  return ['127.0.0.1', 'localhost', '[::1]'].some((name) => host === `${name}:${port}`);
}

/** Verify the caller's bearer token; on failure writes a 401 challenge. */
function authenticate(req, res, { tokens, resource, issuer, log }) {
  const header = String(req.headers.authorization || '');
  if (!header.toLowerCase().startsWith('bearer ')) {
    challenge(res, issuer, resource, 'invalid_token', 'Missing bearer token');
    return null;
  }
  const token = header.slice(7).trim();
  const check = tokens.verifyAccessToken(token, { audience: resource });
  if (!check.ok) {
    log.warn(`rejected token: ${check.description}`);
    challenge(res, issuer, resource, check.error, check.description);
    return null;
  }
  const scopes = String(check.payload.scope || '')
    .split(/[\s+]+/)
    .filter(Boolean);
  return { token, payload: check.payload, clientId: check.payload.client_id, scopes };
}

/**
 * 401 with the RFC 9728 pointer that makes MCP clients start the OAuth flow
 * automatically.
 */
function challenge(res, issuer, resource, error, description) {
  const prm = `${issuer}/.well-known/oauth-protected-resource/mcp`;
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'WWW-Authenticate':
      `Bearer realm="wb-agent-gateway", resource_metadata="${prm}", error="${error}", error_description="${description}"`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id'
  });
  res.end(
    JSON.stringify({
      error,
      error_description: description,
      resource_metadata: prm,
      authorization_servers: [issuer]
    })
  );
}

/** Forward ACP traffic to the upstream /api/v1/acp endpoint, streaming the reply. */
async function proxyAcp(req, res, url, upstream, log) {
  const suffix = url.pathname.replace(/^\/acp/, '');
  const target = `/api/v1/acp${suffix}`;
  const query = Object.fromEntries(url.searchParams.entries());
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;

  try {
    const upstreamRes = await upstream.openStream(target, {
      method: req.method,
      query,
      body,
      headers: {
        Accept: req.headers.accept || 'text/event-stream',
        ...(req.headers['acp-connection-id'] ? { 'acp-connection-id': req.headers['acp-connection-id'] } : {})
      }
    });
    res.writeHead(upstreamRes.status, {
      'Content-Type': upstreamRes.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (!upstreamRes.body) {
      res.end();
      return;
    }
    const reader = upstreamRes.body.getReader();
    // `req` does not emit close once its body is consumed; `res` does on disconnect.
    res.on('close', () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    log.error(`ACP proxy failed: ${err.message}`);
    if (!res.headersSent) sendJson(res, 502, { error: 'upstream_error', error_description: err.message });
    else res.end();
  }
}

function landingPage(config) {
  const base = config.publicUrl;
  return page(
    'WorkBuddy agent gateway',
    `
    <h1>WorkBuddy agent gateway</h1>
    <p class="lede">
      Two ways in, one OAuth token. Point MCP clients at <code>${esc(base)}/mcp</code>, or point
      OpenAI-compatible clients at <code>${esc(base)}/v1</code>. Both discover the authorization
      server automatically.
    </p>

    <table class="facts">
      <tr><th>MCP endpoint</th><td><code>${esc(base)}/mcp</code></td></tr>
      <tr><th>OpenAI base URL</th><td><code>${esc(base)}/v1</code><br />
        <code>POST /v1/chat/completions</code> &middot; <code>POST /v1/completions</code> &middot;
        <code>GET /v1/models</code> &middot; <code>GET /v1/tools</code></td></tr>
      <tr><th>Resource metadata</th><td><code>${esc(base)}/.well-known/oauth-protected-resource</code></td></tr>
      <tr><th>AS metadata</th><td><code>${esc(base)}/.well-known/oauth-authorization-server</code></td></tr>
      <tr><th>Upstream agent</th><td><code>${esc(config.upstream.baseUrl)}</code></td></tr>
      <tr><th>Scopes</th><td><code>${esc(config.scopes.join(' '))}</code></td></tr>
      <tr><th>ACP passthrough</th><td><code>${config.exposeAcp ? `${esc(base)}/acp` : 'disabled'}</code></td></tr>
    </table>

    <div class="warn">
      Tokens issued here can run commands and read/write files as your user. Keep this
      listener on loopback and treat the approval passphrase like a password.
    </div>

    <p class="foot">
      MCP: <code>{"url": "${esc(base)}/mcp"}</code><br />
      OpenAI: <code>base_url="${esc(base)}/v1"</code>, <code>api_key="&lt;your access token&gt;"</code><br />
      Tools: <code>${esc(config.openai.toolsMode)}</code> mode &mdash; <code>translate</code> bridges OpenAI
      function calling onto the agent, <code>ignore</code> answers in text, <code>reject</code> returns 400.
      Use <code>/mcp</code> when the caller must drive the agent's own tools.
    </p>
    `
  );
}

export { makeLogger, sendJson, sendHtml, readBody };
