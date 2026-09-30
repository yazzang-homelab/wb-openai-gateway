/**
 * OAuth 2.0 Authorization Server for downstream agents.
 *
 * Implements the pieces an MCP client needs to authenticate:
 *   RFC 8414  Authorization Server Metadata
 *   RFC 9728  OAuth 2.0 Protected Resource Metadata
 *   RFC 7591  Dynamic Client Registration
 *   RFC 7636  PKCE (S256 only)
 *   RFC 7009  Token Revocation
 *
 * The authorization step is gated behind a human approval passphrase, because a
 * token issued here grants the ability to run commands and read/write files on
 * this machine through the local agent service.
 */
import { randomId, timingSafeEqual, verifyPkce } from './tokens.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CONSENT_ATTEMPTS = 8;
const NO_ACCESS_CODE =
  'No approval passphrase (accessCode) is configured, so no client can be approved. ' +
  'Set WB_AGENT_GATEWAY_ACCESS_CODE or accessCode in the config and restart the gateway.';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function isAbsoluteUri(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'custom' || Boolean(u.protocol);
  } catch {
    return false;
  }
}

export class OAuthServer {
  constructor({ config, store, tokens, log }) {
    this.cfg = config;
    this.store = store;
    this.tokens = tokens;
    this.log = log;
    this.codes = new Map();
    this.consentAttempts = new Map();
    this.issuer = config.publicUrl;
    this.resource = `${config.publicUrl}/mcp`;
  }

  get clients() {
    return this.store.get('clients', {});
  }

  saveClients(next) {
    this.store.set('clients', next);
  }

  getClient(clientId) {
    if (!clientId) return null;
    return this.clients[clientId] || null;
  }

  // ---------------------------------------------------------------- metadata

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      revocation_endpoint: `${this.issuer}/revoke`,
      scopes_supported: this.cfg.scopes,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      service_documentation: `${this.issuer}/`,
      'x-agent-gateway': {
        upstream: this.cfg.upstream.baseUrl,
        transports: ['streamable-http', 'sse']
      }
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: this.cfg.scopes,
      bearer_methods_supported: ['header'],
      resource_name: 'WorkBuddy local agent',
      resource_documentation: `${this.issuer}/`
    };
  }

  // ------------------------------------------------------------------ router

  /** @returns {boolean} true when the request was handled here. */
  async handle(req, res, url, helpers) {
    const { sendJson, readBody } = helpers;
    const p = url.pathname.replace(/\/+$/, '') || '/';

    // --- discovery ---------------------------------------------------------
    if (req.method === 'GET' && p.startsWith('/.well-known/oauth-authorization-server')) {
      sendJson(res, 200, this.authorizationServerMetadata());
      return true;
    }
    if (req.method === 'GET' && p.startsWith('/.well-known/oauth-protected-resource')) {
      sendJson(res, 200, this.protectedResourceMetadata());
      return true;
    }
    if (req.method === 'GET' && p === '/.well-known/openid-configuration') {
      sendJson(res, 200, this.authorizationServerMetadata());
      return true;
    }

    // --- dynamic client registration ---------------------------------------
    if (p === '/register' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        sendJson(res, 201, this.register(body));
      } catch (err) {
        sendJson(res, err.status || 400, {
          error: err.oauthError || 'invalid_client_metadata',
          error_description: err.message
        });
      }
      return true;
    }

    // --- authorization -----------------------------------------------------
    if (p === '/authorize' && req.method === 'GET') {
      await this.authorizePage(req, res, url, helpers);
      return true;
    }
    if (p === '/authorize' && req.method === 'POST') {
      await this.authorizeDecision(req, res, helpers);
      return true;
    }

    // --- token -------------------------------------------------------------
    if (p === '/token' && req.method === 'POST') {
      const body = await readBody(req);
      await this.token(req, res, body, helpers);
      return true;
    }
    if (p === '/revoke' && req.method === 'POST') {
      const body = await readBody(req);
      this.revoke(req, res, body, helpers);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------- DCR (7591)

  register(body) {
    const raw = body && typeof body === 'object' ? body : {};
    const redirectUris = Array.isArray(raw.redirect_uris) ? raw.redirect_uris : [];
    if (redirectUris.length === 0) {
      throw Object.assign(new Error('redirect_uris is required and must contain at least one URI'), {
        status: 400,
        oauthError: 'invalid_redirect_uri'
      });
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || !isAbsoluteUri(uri)) {
        throw Object.assign(new Error(`Invalid redirect_uri: ${uri}`), {
          status: 400,
          oauthError: 'invalid_redirect_uri'
        });
      }
    }

    const requestedScopes = String(raw.scope || '')
      .split(/[\s+]+/)
      .filter(Boolean);
    const granted = requestedScopes.length
      ? requestedScopes.filter((s) => this.cfg.scopes.includes(s))
      : [...this.cfg.scopes];
    const scope = (granted.length ? granted : this.cfg.scopes).join(' ');

    const authMethod = raw.token_endpoint_auth_method || 'none';
    const clientId = `wb_${randomId(18)}`;
    const record = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: raw.client_name || raw.client_id || 'unnamed-agent',
      redirect_uris: redirectUris,
      grant_types: raw.grant_types || ['authorization_code', 'refresh_token'],
      response_types: raw.response_types || ['code'],
      token_endpoint_auth_method: authMethod,
      scope,
      software_id: raw.software_id,
      software_version: raw.software_version,
      registered_at: new Date().toISOString()
    };

    let clientSecret;
    if (authMethod !== 'none') {
      clientSecret = randomId(32);
      record.client_secret = clientSecret;
      record.client_secret_expires_at = 0;
    }

    const clients = { ...this.clients, [clientId]: record };
    this.saveClients(clients);
    this.log.info(`registered client ${clientId} (${record.client_name})`);

    const out = { ...record };
    delete out.registered_at;
    if (clientSecret) out.client_secret = clientSecret;
    return out;
  }

  // ------------------------------------------------------- authorize endpoint

  #authorizeParams(url) {
    const q = url.searchParams;
    return {
      responseType: q.get('response_type'),
      clientId: q.get('client_id'),
      redirectUri: q.get('redirect_uri'),
      scope: q.get('scope'),
      state: q.get('state'),
      codeChallenge: q.get('code_challenge'),
      codeChallengeMethod: q.get('code_challenge_method') || 'S256',
      resource: q.get('resource') || this.resource
    };
  }

  #validateAuthorizeParams(params) {
    const client = this.getClient(params.clientId);
    if (!client) {
      return { error: 'invalid_client', description: 'Unknown client_id. Register with POST /register first.', fatal: true };
    }
    if (params.responseType !== 'code') {
      return { error: 'unsupported_response_type', description: 'Only response_type=code is supported.', client };
    }
    if (!params.redirectUri) {
      return { error: 'invalid_request', description: 'redirect_uri is required.', client };
    }
    if (!client.redirect_uris.includes(params.redirectUri)) {
      return {
        error: 'invalid_redirect_uri',
        description: 'redirect_uri does not exactly match a registered redirect URI.',
        fatal: true
      };
    }
    if (!params.codeChallenge) {
      return { error: 'invalid_request', description: 'code_challenge is required (PKCE).', client };
    }
    if (params.codeChallengeMethod !== 'S256') {
      return { error: 'invalid_request', description: 'Only code_challenge_method=S256 is supported.', client };
    }
    return { client };
  }

  async authorizePage(req, res, url, { sendHtml }) {
    if (!this.cfg.accessCode) {
      sendHtml(res, 503, errorPage('Approval is disabled', NO_ACCESS_CODE));
      return;
    }
    const params = this.#authorizeParams(url);
    const check = this.#validateAuthorizeParams(params);

    if (check.error && check.fatal) {
      sendHtml(res, 400, errorPage('Authorization request rejected', check.description));
      return;
    }
    if (check.error) {
      this.#redirectError(res, params.redirectUri, check.error, check.description, params.state);
      return;
    }

    const client = check.client;
    const requested = (params.scope || client.scope).split(/[\s+]+/).filter(Boolean);
    const scopes = requested.filter((s) => this.cfg.scopes.includes(s));
    const scope = (scopes.length ? scopes : this.cfg.scopes).join(' ');

    sendHtml(res, 200, this.#consentPage({ params, client, scope, error: url.searchParams.get('error') }));
  }

  #consentPage({ params, client, scope, error }) {
    const hidden = (name, value) =>
      `<input type="hidden" name="${esc(name)}" value="${esc(value ?? '')}" />`;

    return page(
      'Authorize agent access',
      `
      <h1>Authorize access to the local agent</h1>
      <p class="lede">
        <strong>${esc(client.client_name)}</strong> is requesting an OAuth token for the
        WorkBuddy / CodeBuddy agent running on this machine.
      </p>

      <div class="warn">
        <strong>This grants real power.</strong> A token issued here can run shell commands,
        read and write files, and dispatch background agents as your user account.
        Only approve clients you recognise.
      </div>

      ${error ? `<div class="error">${esc(error)}</div>` : ''}

      <table class="facts">
        <tr><th>Client</th><td>${esc(client.client_name)}<br /><code>${esc(client.client_id)}</code></td></tr>
        <tr><th>Redirect</th><td><code>${esc(params.redirectUri)}</code></td></tr>
        <tr><th>Scopes</th><td>${esc(scope)}</td></tr>
        <tr><th>Resource</th><td><code>${esc(params.resource)}</code></td></tr>
        <tr><th>Agent</th><td><code>${esc(this.cfg.upstream.baseUrl)}</code></td></tr>
      </table>

      <form method="post" action="/authorize">
        ${hidden('client_id', params.clientId)}
        ${hidden('redirect_uri', params.redirectUri)}
        ${hidden('scope', scope)}
        ${hidden('state', params.state)}
        ${hidden('code_challenge', params.codeChallenge)}
        ${hidden('code_challenge_method', params.codeChallengeMethod)}
        ${hidden('resource', params.resource)}
        <label for="access_code">Approval passphrase</label>
        <input id="access_code" name="access_code" type="password" autocomplete="off"
               autofocus placeholder="Set in the gateway config" />
        <div class="actions">
          <button type="submit" name="decision" value="allow" class="primary">Approve</button>
          <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
        </div>
      </form>
      <p class="foot">Passphrase is configured as <code>accessCode</code> in the gateway config.</p>
      `
    );
  }

  async authorizeDecision(req, res, { readBody, sendHtml }) {
    const body = await readBody(req);
    if (!this.cfg.accessCode) {
      sendHtml(res, 503, errorPage('Approval is disabled', NO_ACCESS_CODE));
      return;
    }
    const params = {
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      scope: body.scope,
      state: body.state,
      codeChallenge: body.code_challenge,
      codeChallengeMethod: body.code_challenge_method || 'S256',
      resource: body.resource || this.resource
    };
    const check = this.#validateAuthorizeParams({ ...params, responseType: 'code' });
    if (check.error) {
      sendHtml(res, 400, errorPage('Authorization request rejected', check.description));
      return;
    }

    if (body.decision !== 'allow') {
      this.#redirectError(res, params.redirectUri, 'access_denied', 'The user denied the request.', params.state);
      return;
    }

    const key = params.clientId;
    const attempts = (this.consentAttempts.get(key) || 0) + 1;
    this.consentAttempts.set(key, attempts);
    if (attempts > MAX_CONSENT_ATTEMPTS) {
      sendHtml(res, 429, errorPage('Too many attempts', 'Restart the gateway to reset the attempt counter.'));
      return;
    }
    if (!timingSafeEqual(body.access_code || '', this.cfg.accessCode)) {
      const client = this.getClient(params.clientId);
      sendHtml(
        res,
        401,
        this.#consentPage({
          params,
          client,
          scope: params.scope,
          error: 'Incorrect approval passphrase.'
        })
      );
      return;
    }
    this.consentAttempts.delete(key);

    const code = randomId(32);
    this.codes.set(code, {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      scope: params.scope,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      resource: params.resource,
      expiresAt: Date.now() + CODE_TTL_MS
    });
    this.#pruneCodes();

    const audit = this.store.get('consents', []);
    audit.push({
      at: new Date().toISOString(),
      clientId: params.clientId,
      clientName: this.getClient(params.clientId)?.client_name,
      scope: params.scope,
      redirectUri: params.redirectUri
    });
    this.store.set('consents', audit.slice(-200));

    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state) target.searchParams.set('state', params.state);
    res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  #redirectError(res, redirectUri, error, description, state) {
    const target = new URL(redirectUri);
    target.searchParams.set('error', error);
    if (description) target.searchParams.set('error_description', description);
    if (state) target.searchParams.set('state', state);
    res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  #pruneCodes() {
    const now = Date.now();
    for (const [code, rec] of this.codes) if (rec.expiresAt < now) this.codes.delete(code);
  }

  // ----------------------------------------------------------- token endpoint

  async token(req, res, body, { sendJson }) {
    const grantType = body.grant_type;
    const clientId = body.client_id || basicAuthClient(req)?.id;
    const clientSecret = body.client_secret || basicAuthClient(req)?.secret;
    const client = this.getClient(clientId);

    if (!client) {
      res.setHeader('WWW-Authenticate', 'Basic realm="wb-agent-gateway"');
      sendJson(res, 401, { error: 'invalid_client', error_description: 'Unknown client_id.' });
      return;
    }
    if (client.token_endpoint_auth_method !== 'none') {
      if (!clientSecret || !timingSafeEqual(clientSecret, client.client_secret || '')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="wb-agent-gateway"');
        sendJson(res, 401, { error: 'invalid_client', error_description: 'Bad client credentials.' });
        return;
      }
    }

    if (grantType === 'authorization_code') {
      const rec = this.codes.get(body.code);
      if (!rec) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'Unknown or already used code.' });
        return;
      }
      if (rec.expiresAt < Date.now()) {
        this.codes.delete(body.code);
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'Authorization code expired.' });
        return;
      }
      if (rec.clientId !== clientId) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'Code was issued to another client.' });
        return;
      }
      if (body.redirect_uri && body.redirect_uri !== rec.redirectUri) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch.' });
        return;
      }
      if (!verifyPkce(body.code_verifier, rec.codeChallenge, rec.codeChallengeMethod)) {
        // Deliberately do NOT consume the code here: a mistyped verifier should
        // not force the user back through the consent screen. High-entropy
        // verifiers make brute force impractical.
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' });
        return;
      }
      // Valid: authorization codes are strictly single-use.
      this.codes.delete(body.code);
      sendJson(res, 200, this.#issue(client, rec.scope, rec.resource));
      return;
    }

    if (grantType === 'refresh_token') {
      const rec = this.tokens.consumeRefreshToken(body.refresh_token, clientId);
      if (!rec) {
        sendJson(res, 400, { error: 'invalid_grant', error_description: 'Unknown or expired refresh token.' });
        return;
      }
      sendJson(res, 200, this.#issue(client, rec.scope, rec.audience));
      return;
    }

    sendJson(res, 400, {
      error: 'unsupported_grant_type',
      error_description: 'Supported grant types: authorization_code, refresh_token.'
    });
  }

  #issue(client, scope, resource) {
    const { token, payload } = this.tokens.mintAccessToken({
      clientId: client.client_id,
      scope,
      audience: resource || this.resource,
      subject: client.client_id
    });
    const refresh = this.tokens.mintRefreshToken({
      clientId: client.client_id,
      scope,
      audience: resource || this.resource
    });
    this.log.info(`issued token for ${client.client_id} (${client.client_name}) scope="${scope}"`);
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.cfg.accessTokenTtl,
      refresh_token: refresh,
      scope,
      resource: payload.aud
    };
  }

  revoke(req, res, body, { sendJson }) {
    const value = body.token;
    if (value) {
      if (typeof value === 'string' && value.startsWith('v1.')) {
        const parts = value.split('.');
        try {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          this.tokens.revokeJti(payload.jti, payload.exp);
        } catch {
          /* ignore malformed */
        }
      } else {
        const records = this.store.get('refreshTokens', {});
        if (records[value]) {
          delete records[value];
          this.store.set('refreshTokens', records);
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end('{}');
  }
}

function basicAuthClient(req) {
  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    return { id: decodeURIComponent(decoded.slice(0, idx)), secret: decodeURIComponent(decoded.slice(idx + 1)) };
  } catch {
    return null;
  }
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --ink: #16181d; --muted: #5c6470;
    --line: #e3e6ea; --accent: #2f6feb; --danger: #b42318; --danger-bg: #fef3f2;
    --warn-bg: #fffaeb; --warn-line: #f2d08a; --warn-ink: #7a4c00;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 20px; background: var(--bg); color: var(--ink);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  }
  main {
    max-width: 620px; margin: 0 auto; background: var(--card); border: 1px solid var(--line);
    border-radius: 14px; padding: 32px; box-shadow: 0 1px 2px rgba(16,24,40,.05), 0 8px 24px rgba(16,24,40,.06);
  }
  h1 { font-size: 21px; margin: 0 0 10px; letter-spacing: -.01em; }
  .lede { color: var(--muted); margin: 0 0 18px; }
  .warn {
    background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn-ink);
    border-radius: 10px; padding: 12px 14px; margin: 0 0 18px; font-size: 14px;
  }
  .error {
    background: var(--danger-bg); border: 1px solid #f4c7c3; color: var(--danger);
    border-radius: 10px; padding: 10px 14px; margin: 0 0 16px; font-size: 14px;
  }
  table.facts { width: 100%; border-collapse: collapse; margin: 0 0 22px; font-size: 14px; }
  table.facts th {
    text-align: left; width: 110px; color: var(--muted); font-weight: 500;
    padding: 7px 10px 7px 0; vertical-align: top; border-bottom: 1px solid var(--line);
  }
  table.facts td { padding: 7px 0; border-bottom: 1px solid var(--line); word-break: break-all; }
  code {
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    background: #f2f4f7; padding: 1px 5px; border-radius: 5px;
  }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  input[type=password] {
    width: 100%; padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px;
    font-size: 15px; margin-bottom: 20px; background: #fff; color: var(--ink);
  }
  input[type=password]:focus { outline: 2px solid rgba(47,111,235,.35); border-color: var(--accent); }
  .actions { display: flex; gap: 10px; }
  button {
    flex: 1; padding: 11px 18px; border-radius: 9px; font-size: 15px; font-weight: 550;
    cursor: pointer; border: 1px solid transparent;
  }
  button.primary { background: var(--accent); color: #fff; }
  button.primary:hover { background: #245ccf; }
  button.secondary { background: #fff; color: var(--ink); border-color: var(--line); }
  button.secondary:hover { background: #f4f5f7; }
  .foot { color: var(--muted); font-size: 12.5px; margin: 18px 0 0; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function errorPage(title, detail) {
  return page(title, `<h1>${esc(title)}</h1><p class="lede">${esc(detail)}</p>`);
}

export { page, errorPage, esc };
