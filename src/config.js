/**
 * Configuration resolution.
 *
 * Precedence (highest first):
 *   CLI flags  >  environment variables  >  config file  >  built-in defaults
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PERMISSION_MODES } from './tools.js';

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.wb-agent-gateway', 'config.json');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8931,
  /** Public base URL advertised in OAuth metadata. Defaults to http://<host>:<port>. */
  publicUrl: null,
  /** Human approval passphrase required on the consent screen. */
  accessCode: null,
  /** Token lifetimes, seconds. */
  accessTokenTtl: 3600,
  refreshTokenTtl: 60 * 60 * 24 * 30,
  /** Advertised scopes. */
  scopes: ['agent:read', 'agent:run'],
  dataDir: null,
  upstream: {
    /** e.g. http://127.0.0.1:8399 -- null means auto-discover. */
    baseUrl: null,
    /** Gateway password for `codebuddy --serve`. null means read settings.json. */
    password: null,
    /** Try `codebuddy daemon status` when baseUrl is unknown. */
    discover: true,
    /** Path to the bundled CodeBuddy CLI, used for discovery and auto-start. */
    cliPath: null,
    /** Spawn and supervise `codebuddy --serve` when nothing is listening. */
    autoStart: false,
    /** Port used when auto-starting. */
    servePort: 8399,
    /** Extra args appended to `codebuddy --serve --port <n> --host 127.0.0.1`. */
    serveArgs: [],
    /** Extra environment for the spawned upstream (e.g. CODEBUDDY_API_KEY). */
    env: {},
    /** How long to wait for a spawned upstream to become healthy. */
    startTimeoutMs: 90_000,
    /** How many times to restart a crashed upstream before giving up. */
    maxRestarts: 5,
    /** Extra headers forwarded on every upstream call. */
    headers: {},
    requestTimeoutMs: 120_000
  },
  /** Expose a pass-through for the ACP-over-SSE endpoint at /acp. */
  exposeAcp: true,
  openai: {
    /**
     * What to do when a client declares OpenAI `tools`.
     *
     * The upstream is an autonomous agent, not a raw model: it runs its own tool
     * loop and cannot be asked to return a tool call natively. The gateway can
     * still bridge the two formats:
     *
     *   "ignore" (default) - answer in plain text and flag it with the
     *                        X-WorkBuddy-Tools-Ignored response header.
     *   "reject"           - fail fast with a 400 so a framework that needs
     *                        tool_calls does not silently loop.
     *   "translate"        - bridge OpenAI function calling onto the agent: the
     *                        declared schemas are given to the agent as a tool
     *                        protocol, and a structured tool request is turned
     *                        back into a real `tool_calls` response.
     */
    toolsMode: 'ignore',
    /**
     * Permission mode for OpenAI-endpoint jobs that do not pass
     * `workbuddy.permissionMode`. An OpenAI request has no channel to answer a
     * permission prompt, so a prompting mode can only end in
     * `409 agent_needs_input`. "dontAsk" runs pre-approved and safe actions and
     * denies anything that would need approval, so the job always settles.
     */
    permissionMode: 'dontAsk',
    /**
     * Backend models the agent may run on. Each id is exposed as
     * `<pseudo-model>:<backend-model>` (e.g. `workbuddy:gpt-5.5`) and dispatched
     * with that backend model, so OpenAI clients can pick the model by id alone.
     */
    backendModels: []
  },
  logLevel: 'info'
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Locate the CodeBuddy CLI shipped inside the WorkBuddy desktop app. */
export function findCliPath() {
  const candidates = [
    process.env.CODEBUDDY_CLI_PATH,
    '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    path.join(os.homedir(), 'Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy')
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Read the gateway password that `codebuddy --serve` generated on first start. */
export function readGatewayPassword() {
  if (process.env.CODEBUDDY_GATEWAY_PASSWORD) return process.env.CODEBUDDY_GATEWAY_PASSWORD;
  const settings = readJson(path.join(os.homedir(), '.codebuddy', 'settings.json'));
  const pw = settings?.gateway?.password;
  return typeof pw === 'string' && pw.length > 0 ? pw : null;
}

/**
 * Detect how the agent authenticates to its model backend.
 *
 * This is a different axis from the gateway password: the password protects the
 * local HTTP API, these credentials let the agent actually call a model. The
 * CLI resolves them in this priority order:
 *
 *   1. CODEBUDDY_AUTH_TOKEN   OAuth token (highest priority)
 *   2. apiKeyHelper           enterprise OAuth helper script, from settings.json
 *   3. CODEBUDDY_API_KEY      static API key
 *
 * `CODEBUDDY_API_KEY` additionally needs CODEBUDDY_INTERNET_ENVIRONMENT
 * (unset = international, `internal` = China, `ioa`, `cloudhosted`, `selfhosted`).
 *
 * @returns {Array<{source:string, method:string, note:string, envBased:boolean}>}
 */
export function detectCredentials(env = process.env, settingsFile) {
  const file = settingsFile || path.join(os.homedir(), '.codebuddy', 'settings.json');
  const found = [];
  const push = (source, method, note, envBased) => found.push({ source, method, note, envBased });

  if (env.CODEBUDDY_AUTH_TOKEN) {
    push('environment', 'CODEBUDDY_AUTH_TOKEN', 'OAuth token (highest priority)', true);
  }
  for (const key of ['ACC_PRODUCT_CONFIG_V3', 'ACC_PRODUCT_CONFIG_V2']) {
    if (!env[key]) continue;
    try {
      const parsed = JSON.parse(env[key]);
      if (parsed?.authentication?.type === 'custom-token' && parsed.authentication?.attributes?.token) {
        push(`environment ${key}`, 'ACC_PRODUCT_CONFIG (custom-token)', 'enterprise configuration', true);
      }
    } catch {
      /* not JSON, ignore */
    }
  }
  if (env.CODEBUDDY_API_KEY) {
    const region = env.CODEBUDDY_INTERNET_ENVIRONMENT
      ? `region "${env.CODEBUDDY_INTERNET_ENVIRONMENT}"`
      : 'international region (CODEBUDDY_INTERNET_ENVIRONMENT unset)';
    push('environment', 'CODEBUDDY_API_KEY', `static API key, ${region}`, true);
  }
  if (env.ACC_PRODUCT_CONFIG_PATH) {
    push('environment', 'ACC_PRODUCT_CONFIG_PATH', 'configuration file path', true);
  }

  const settings = readJson(file);
  if (settings?.env?.CODEBUDDY_AUTH_TOKEN) {
    push(`${file} env.CODEBUDDY_AUTH_TOKEN`, 'CODEBUDDY_AUTH_TOKEN', 'OAuth token (highest priority)', false);
  }
  if (settings?.env?.CODEBUDDY_API_KEY) {
    push(`${file} env.CODEBUDDY_API_KEY`, 'CODEBUDDY_API_KEY', 'static API key', false);
  }
  if (settings?.apiKeyHelper) {
    push(`${file} apiKeyHelper`, 'apiKeyHelper', String(settings.apiKeyHelper), false);
  }

  return found;
}

/** Pick the credential the CLI would actually use, given its priority order. */
export function effectiveCredential(credentials) {
  const order = ['CODEBUDDY_AUTH_TOKEN', 'apiKeyHelper', 'CODEBUDDY_API_KEY'];
  for (const method of order) {
    const hit = credentials.find((c) => c.method === method);
    if (hit) return hit;
  }
  return credentials[0] || null;
}

/** Ask a running daemon for its endpoint. Returns null when nothing is running. */
export function discoverUpstreamUrl(cliPath, timeoutMs = 15_000) {
  if (!cliPath) return null;
  try {
    const out = execFileSync(process.execPath, [cliPath, 'daemon', 'status'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const parsed = JSON.parse(out.slice(out.indexOf('{')));
    if (parsed?.status === 'running' && parsed.endpoint) return parsed.endpoint;
  } catch {
    /* no daemon running, or CLI unavailable */
  }
  return null;
}

function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  return undefined;
}

export function loadConfig({ configPath, argv = {} } = {}) {
  const file = configPath || process.env.WB_AGENT_GATEWAY_CONFIG || DEFAULT_CONFIG_PATH;
  const fromFile = readJson(file) || {};

  const fromEnv = {
    host: process.env.WB_AGENT_GATEWAY_HOST,
    port: process.env.WB_AGENT_GATEWAY_PORT ? Number(process.env.WB_AGENT_GATEWAY_PORT) : undefined,
    publicUrl: process.env.WB_AGENT_GATEWAY_PUBLIC_URL,
    accessCode: process.env.WB_AGENT_GATEWAY_ACCESS_CODE,
    dataDir: process.env.WB_AGENT_GATEWAY_DATA_DIR,
    logLevel: process.env.WB_AGENT_GATEWAY_LOG_LEVEL,
    exposeAcp: coerceBool(process.env.WB_AGENT_GATEWAY_EXPOSE_ACP),
    openai: {
      toolsMode: process.env.WB_AGENT_GATEWAY_TOOLS_MODE,
      permissionMode: process.env.WB_AGENT_GATEWAY_PERMISSION_MODE
    },
    upstream: {
      baseUrl: process.env.CODEBUDDY_GATEWAY_URL,
      password: process.env.CODEBUDDY_GATEWAY_PASSWORD,
      cliPath: process.env.CODEBUDDY_CLI_PATH,
      autoStart: coerceBool(process.env.WB_AGENT_GATEWAY_SPAWN_UPSTREAM),
      servePort: process.env.CODEBUDDY_SERVE_PORT ? Number(process.env.CODEBUDDY_SERVE_PORT) : undefined
    }
  };

  const fromArgv = {
    host: argv.host,
    port: argv.port !== undefined ? Number(argv.port) : undefined,
    publicUrl: argv.publicUrl,
    accessCode: argv.accessCode,
    dataDir: argv.dataDir,
    logLevel: argv.logLevel,
    openai: {
      toolsMode: argv.toolsMode,
      permissionMode: argv.permissionMode
    },
    upstream: {
      baseUrl: argv.upstreamUrl,
      password: argv.upstreamPassword,
      cliPath: argv.cliPath,
      autoStart: coerceBool(argv.spawnUpstream),
      servePort: argv.servePort !== undefined ? Number(argv.servePort) : undefined
    }
  };

  const merged = deepMerge(
    deepMerge(deepMerge(DEFAULTS, fromFile), fromEnv),
    fromArgv
  );

  if (!merged.publicUrl) {
    const shown = merged.host === '0.0.0.0' || merged.host === '::' ? '127.0.0.1' : merged.host;
    merged.publicUrl = `http://${shown}:${merged.port}`;
  }
  merged.publicUrl = merged.publicUrl.replace(/\/+$/, '');

  merged.dataDir = merged.dataDir || path.join(os.homedir(), '.wb-agent-gateway');
  merged.configPath = file;

  if (!['ignore', 'reject', 'translate'].includes(merged.openai.toolsMode)) {
    if (merged.openai.toolsMode !== undefined) {
      throw new Error(
        `openai.toolsMode must be "ignore", "reject" or "translate", got "${merged.openai.toolsMode}"`
      );
    }
    merged.openai.toolsMode = 'ignore';
  }

  if (!PERMISSION_MODES.includes(merged.openai.permissionMode)) {
    throw new Error(
      `openai.permissionMode must be one of ${PERMISSION_MODES.join(', ')}, got "${merged.openai.permissionMode}"`
    );
  }

  if (!merged.upstream.password) merged.upstream.password = readGatewayPassword();
  if (!merged.upstream.cliPath) merged.upstream.cliPath = findCliPath();
  if (!merged.upstream.baseUrl && merged.upstream.discover) {
    merged.upstream.baseUrl = discoverUpstreamUrl(merged.upstream.cliPath);
  }
  // When we intend to spawn the upstream ourselves, target the port we will use.
  if (!merged.upstream.baseUrl) {
    merged.upstream.baseUrl = `http://127.0.0.1:${merged.upstream.servePort}`;
  }

  return merged;
}

export function describeConfig(cfg) {
  return {
    listen: `${cfg.host}:${cfg.port}`,
    publicUrl: cfg.publicUrl,
    dataDir: cfg.dataDir,
    configPath: cfg.configPath,
    upstreamBaseUrl: cfg.upstream.baseUrl,
    upstreamPassword: cfg.upstream.password ? `set (${cfg.upstream.password.length} chars)` : 'not set',
    upstreamAutoStart: cfg.upstream.autoStart ? `yes (port ${cfg.upstream.servePort})` : 'no',
    openaiToolsMode: cfg.openai.toolsMode,
    openaiPermissionMode: cfg.openai.permissionMode,
    accessCode: cfg.accessCode ? 'set' : 'NOT SET (consent is disabled: no new client can be approved)',
    scopes: cfg.scopes
  };
}
