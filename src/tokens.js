/**
 * Access-token minting/verification and PKCE helpers.
 *
 * Access tokens are self-contained and HMAC-SHA256 signed, so verification is
 * stateless and survives restarts:
 *
 *     v1.<base64url(payload)>.<base64url(hmac)>
 */
import crypto from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (str) => Buffer.from(str, 'base64url');

export function randomId(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // still compare to keep timing flat
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function sha256base64url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

/** PKCE (RFC 7636) verification. Only S256 is supported. */
export function verifyPkce(codeVerifier, codeChallenge, method = 'S256') {
  if (!codeVerifier || !codeChallenge) return false;
  if (method !== 'S256') return false;
  return timingSafeEqual(sha256base64url(codeVerifier), codeChallenge);
}

export class TokenService {
  constructor({ secret, issuer, accessTokenTtl, refreshTokenTtl, store }) {
    this.key = Buffer.from(secret, 'utf8');
    this.issuer = issuer;
    this.accessTokenTtl = accessTokenTtl;
    this.refreshTokenTtl = refreshTokenTtl;
    this.store = store;
  }

  #sign(payloadB64) {
    return crypto.createHmac('sha256', this.key).update(payloadB64).digest('base64url');
  }

  mintAccessToken({ clientId, scope, audience, subject }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1,
      iss: this.issuer,
      sub: subject || clientId,
      client_id: clientId,
      aud: audience,
      scope,
      iat: now,
      exp: now + this.accessTokenTtl,
      jti: randomId(16)
    };
    const body = b64u(JSON.stringify(payload));
    return { token: `v1.${body}.${this.#sign(body)}`, payload };
  }

  /** Returns { ok: true, payload } or { ok: false, error }. */
  verifyAccessToken(token, { audience } = {}) {
    if (typeof token !== 'string' || !token.startsWith('v1.')) {
      return { ok: false, error: 'invalid_token', description: 'Malformed access token' };
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { ok: false, error: 'invalid_token', description: 'Malformed access token' };
    }
    const [, body, sig] = parts;
    if (!timingSafeEqual(sig, this.#sign(body))) {
      return { ok: false, error: 'invalid_token', description: 'Bad token signature' };
    }
    let payload;
    try {
      payload = JSON.parse(unb64u(body).toString('utf8'));
    } catch {
      return { ok: false, error: 'invalid_token', description: 'Unparseable token payload' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) {
      return { ok: false, error: 'invalid_token', description: 'Token expired' };
    }
    if (this.isRevoked(payload.jti)) {
      return { ok: false, error: 'invalid_token', description: 'Token revoked' };
    }
    if (audience && payload.aud && payload.aud !== audience) {
      return { ok: false, error: 'invalid_token', description: 'Token audience mismatch' };
    }
    return { ok: true, payload };
  }

  mintRefreshToken({ clientId, scope, audience }) {
    const token = randomId(32);
    const records = this.store.get('refreshTokens', {});
    records[token] = {
      clientId,
      scope,
      audience,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.refreshTokenTtl * 1000
    };
    this.#prune(records);
    this.store.set('refreshTokens', records);
    return token;
  }

  consumeRefreshToken(token, clientId) {
    const records = this.store.get('refreshTokens', {});
    const rec = records[token];
    if (!rec) return null;
    delete records[token];
    this.store.set('refreshTokens', records);
    if (rec.clientId !== clientId) return null;
    if (rec.expiresAt < Date.now()) return null;
    return rec;
  }

  revokeJti(jti, expiresAt) {
    const list = this.store.get('revoked', {});
    list[jti] = expiresAt || Math.floor(Date.now() / 1000) + this.accessTokenTtl;
    this.#pruneRevoked(list);
    this.store.set('revoked', list);
  }

  isRevoked(jti) {
    if (!jti) return false;
    const list = this.store.get('revoked', {});
    const exp = list[jti];
    if (!exp) return false;
    if (exp * 1000 < Date.now()) return false;
    return true;
  }

  #prune(records) {
    const now = Date.now();
    for (const [k, v] of Object.entries(records)) {
      if (!v || v.expiresAt < now) delete records[k];
    }
  }

  #pruneRevoked(list) {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, exp] of Object.entries(list)) {
      if (exp < now) delete list[k];
    }
  }
}
