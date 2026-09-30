#!/usr/bin/env node
/**
 * Issue an access token for a headless OpenAI client (GJC, scripts, SDKs).
 *
 * Runs the same flow an interactive client would: dynamic client registration
 * -> PKCE authorize approved with the gateway access code -> code exchange.
 * The token is written to stdout only, so it can be captured without landing
 * in shell history:
 *
 *   node tools/get-token.mjs --name gjc-laptop > ~/.config/wb-agent/token
 *
 * Options (flag > environment > default):
 *   --url <base>     WB_GATEWAY_URL                    http://127.0.0.1:8931
 *   --name <client>  client_name shown by `clients`    headless-client
 *   --scope <list>   requested scopes                  "agent:read agent:run"
 *   --config <file>  config.json holding accessCode    ~/.wb-agent-gateway/config.json
 *   --allow-insecure-http   permit plain HTTP to a non-loopback host (e.g. over
 *                           a WireGuard/Tailscale link you already trust)
 *
 * The access code comes from WB_AGENT_GATEWAY_ACCESS_CODE, else from the
 * config file. It is sent only to the gateway's own /authorize endpoint.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const base = String(flag('url', process.env.WB_GATEWAY_URL || 'http://127.0.0.1:8931')).replace(/\/+$/, '');
const clientName = flag('name', 'headless-client');
const scope = flag('scope', 'agent:read agent:run');
const configFile = flag('config', path.join(os.homedir(), '.wb-agent-gateway', 'config.json'));
const redirect = 'http://127.0.0.1:9/callback';

const target = new URL(base);
const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
if (target.protocol !== 'https:' && !loopback && !process.argv.includes('--allow-insecure-http')) {
  throw new Error(
    `Refusing to send the access code over plain HTTP to ${target.host}. Use https://, a loopback URL, ` +
      'or pass --allow-insecure-http if the link is already encrypted (VPN).'
  );
}

function accessCode() {
  if (process.env.WB_AGENT_GATEWAY_ACCESS_CODE) return process.env.WB_AGENT_GATEWAY_ACCESS_CODE;
  try {
    const code = JSON.parse(fs.readFileSync(configFile, 'utf8')).accessCode;
    if (typeof code === 'string' && code) return code;
  } catch {
    /* reported below */
  }
  throw new Error(`No access code: set WB_AGENT_GATEWAY_ACCESS_CODE or accessCode in ${configFile}.`);
}

async function json(res, step) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${step} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
}

const code = accessCode();

const reg = await json(
  await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], token_endpoint_auth_method: 'none' })
  }),
  'register'
);
if (!reg.client_id) throw new Error(`register failed: ${JSON.stringify(reg)}`);

const state = crypto.randomBytes(16).toString('hex');
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const auth = await fetch(`${base}/authorize`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: redirect,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    decision: 'allow',
    access_code: code
  })
});
const location = auth.headers.get('location');
if (auth.status < 300 || auth.status > 399 || !location) {
  throw new Error(`authorize failed: HTTP ${auth.status} ${(await auth.text()).slice(0, 300)}`);
}
const callback = new URL(location);
if (`${callback.origin}${callback.pathname}` !== redirect) throw new Error(`authorize redirected elsewhere: ${callback.origin}`);
if (callback.searchParams.get('state') !== state) throw new Error('authorize returned a mismatched state.');
const authCode = callback.searchParams.get('code');
if (!authCode) throw new Error(`authorize was denied: ${callback.searchParams.get('error') || 'no code'}`);

const tok = await json(
  await fetch(`${base}/token`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: redirect,
      client_id: reg.client_id,
      code_verifier: verifier
    })
  }),
  'token'
);
if (!tok.access_token) throw new Error(`token failed: ${JSON.stringify(tok)}`);
process.stderr.write(`issued token for ${reg.client_id} (${clientName}), expires in ${tok.expires_in}s\n`);
process.stdout.write(tok.access_token);
