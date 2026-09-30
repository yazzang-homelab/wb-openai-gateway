#!/usr/bin/env node
/**
 * wb-agent-gateway CLI.
 *
 *   wb-agent-gateway serve             start the OAuth + MCP + OpenAI gateway (default)
 *   wb-agent-gateway doctor            diagnose config, upstream, auth and port
 *   wb-agent-gateway print-config      emit client config (mcp / openai / claude / cursor / vscode)
 *   wb-agent-gateway clients           list dynamically registered clients
 *   wb-agent-gateway rm-client <id>    forget a registered client
 *   wb-agent-gateway install-service   run persistently via launchd (macOS)
 *   wb-agent-gateway uninstall-service remove the launchd agent
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadConfig, describeConfig, detectCredentials, effectiveCredential, DEFAULT_CONFIG_PATH } from '../src/config.js';
import { JsonStore, ensureDir, loadOrCreateKey, atomicWrite } from '../src/store.js';
import { TokenService } from '../src/tokens.js';
import { createServer, makeLogger } from '../src/server.js';
import { MODELS } from '../src/openai.js';

const SERVICE_LABEL = 'ai.workbuddy.agent-gateway';

const HELP = `wb-agent-gateway - OAuth 2.0 protected MCP + OpenAI gateway for the local WorkBuddy agent

Usage:
  wb-agent-gateway serve [options]
  wb-agent-gateway doctor
  wb-agent-gateway print-config [--client mcp|openai|claude|cursor|vscode|generic]
  wb-agent-gateway clients
  wb-agent-gateway rm-client <client_id>
  wb-agent-gateway install-service | uninstall-service

Options:
  --host <addr>              Bind address (default 127.0.0.1)
  --port <n>                 Bind port (default 8931)
  --public-url <url>         URL advertised in OAuth metadata
  --access-code <secret>     Human approval passphrase for the consent screen
  --data-dir <path>          Where keys and registrations are stored
  --upstream-url <url>       Local agent service, e.g. http://127.0.0.1:8399
  --upstream-password <pw>   Gateway password for the local agent service
  --spawn-upstream           Start and supervise \`codebuddy --serve\` ourselves
  --serve-port <n>           Port used when spawning the upstream (default 8399)
  --tools-mode <mode>        OpenAI tools handling: ignore (default) | reject | translate
  --permission-mode <mode>   Permission mode for OpenAI jobs without workbuddy.permissionMode (default dontAsk)
  --cli-path <path>          CodeBuddy CLI, used to discover or spawn the upstream
  --log-level <lvl>          silent|error|warn|info|debug (default info)
  --config <path>            Config file (default ${DEFAULT_CONFIG_PATH})
  -h, --help                 Show this help

Environment:
  WB_AGENT_GATEWAY_ACCESS_CODE, WB_AGENT_GATEWAY_PORT, WB_AGENT_GATEWAY_SPAWN_UPSTREAM,
  CODEBUDDY_GATEWAY_URL, CODEBUDDY_GATEWAY_PASSWORD, CODEBUDDY_CLI_PATH,
  CODEBUDDY_API_KEY (passed to a spawned upstream), WB_AGENT_GATEWAY_CONFIG

Typical use:
  export WB_AGENT_GATEWAY_ACCESS_CODE="$(openssl rand -base64 24)"
  wb-agent-gateway serve --spawn-upstream
  # MCP clients   -> http://127.0.0.1:8931/mcp
  # OpenAI clients-> http://127.0.0.1:8931/v1
`;

function parseArgs(argv) {
  const out = { _: [] };
  const booleans = new Set(['help', 'spawn-upstream']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (a === '-h') out.help = true;
      else out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (booleans.has(key)) {
      out[camel] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) out[camel] = true;
    else out[camel] = value;
  }
  return out;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function buildContext(argv) {
  const config = loadConfig({ configPath: argv.config, argv });
  ensureDir(config.dataDir);
  const store = new JsonStore(path.join(config.dataDir, 'state.json'), {
    clients: {},
    refreshTokens: {},
    revoked: {},
    consents: []
  });
  const secret = loadOrCreateKey(path.join(config.dataDir, 'secret.key'));
  const tokens = new TokenService({
    secret,
    issuer: config.publicUrl,
    accessTokenTtl: config.accessTokenTtl,
    refreshTokenTtl: config.refreshTokenTtl,
    store
  });
  return { config, store, tokens, secret };
}

function printConfig(config, client) {
  const base = config.publicUrl;
  const blocks = {
    mcp: {
      mcpServers: { workbuddy: { type: 'http', url: `${base}/mcp` } }
    },
    claude: {
      mcpServers: { workbuddy: { type: 'http', url: `${base}/mcp` } }
    },
    cursor: {
      mcpServers: { workbuddy: { url: `${base}/mcp` } }
    },
    vscode: {
      servers: { workbuddy: { type: 'http', url: `${base}/mcp` } }
    },
    openai: {
      base_url: `${base}/v1`,
      api_key: '<paste an access token issued by the consent flow>',
      model: MODELS[0].id,
      models: MODELS.map((m) => m.id),
      note:
        'OAuth is required to obtain api_key. Run `wb-agent-gateway print-config --client mcp` to drive the ' +
        'standard flow with an MCP client, or POST /register + /authorize + /token manually.'
    },
    generic: {
      mcpServers: {
        workbuddy: {
          type: 'http',
          url: `${base}/mcp`,
          oauth: {
            authorizationServer: base,
            resourceMetadata: `${base}/.well-known/oauth-protected-resource`,
            scopes: config.scopes
          }
        }
      },
      openaiCompatible: { base_url: `${base}/v1`, model: MODELS[0].id }
    }
  };
  process.stdout.write(`${JSON.stringify(blocks[client] || blocks.generic, null, 2)}\n`);
}

async function probeHealth(config) {
  try {
    const res = await fetch(`${config.upstream.baseUrl}/api/v1/health`, {
      headers: {
        'X-CodeBuddy-Request': '1',
        ...(config.upstream.password ? { Authorization: `Bearer ${config.upstream.password}` } : {})
      },
      signal: AbortSignal.timeout(8000)
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: body?.data ?? body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Does the upstream accept the gateway password we hold? */
async function probeCredential(config) {
  try {
    const res = await fetch(`${config.upstream.baseUrl}/api/v1/auth/status`, {
      headers: {
        'X-CodeBuddy-Request': '1',
        ...(config.upstream.password ? { Authorization: `Bearer ${config.upstream.password}` } : {})
      },
      signal: AbortSignal.timeout(8000)
    });
    const body = await res.json().catch(() => null);
    return body?.data ?? body;
  } catch {
    return null;
  }
}

/**
 * Is the agent signed in to an account? `/api/v1/info` exposes the resolved user
 * name, which stays empty until a sign-in has happened.
 */
async function probeAccount(config) {
  try {
    const res = await fetch(`${config.upstream.baseUrl}/api/v1/info`, {
      headers: {
        'X-CodeBuddy-Request': '1',
        ...(config.upstream.password ? { Authorization: `Bearer ${config.upstream.password}` } : {})
      },
      signal: AbortSignal.timeout(8000)
    });
    const body = await res.json().catch(() => null);
    const info = body?.data ?? body;
    if (!info || typeof info !== 'object') return null;
    const userName = typeof info.userName === 'string' ? info.userName.trim() : '';
    return { signedIn: userName.length > 0, userName: userName || null };
  } catch {
    return null;
  }
}

async function doctor(config, log) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('config file', true, fs.existsSync(config.configPath) ? config.configPath : `${config.configPath} (not created yet, using defaults)`);
  add('data dir', fs.existsSync(config.dataDir), config.dataDir);
  add('upstream url', Boolean(config.upstream.baseUrl), config.upstream.baseUrl);
  add('cli path', Boolean(config.upstream.cliPath), config.upstream.cliPath || 'not found');
  add(
    'upstream autostart',
    true,
    config.upstream.autoStart ? `enabled (port ${config.upstream.servePort})` : 'disabled (start codebuddy --serve yourself)'
  );
  add(
    'access code',
    Boolean(config.accessCode),
    config.accessCode ? 'set' : 'NOT SET - the consent screen refuses every client until one is configured'
  );

  const health = await probeHealth(config);
  if (health.ok) {
    add('upstream reachable', true, JSON.stringify(health.body));

    const credential = await probeCredential(config);
    if (credential) {
      add(
        'upstream password',
        credential.authenticated === true,
        credential.authenticated
          ? 'accepted by the agent service'
          : 'REJECTED - the gateway password is wrong. Delete ~/.codebuddy/settings.json and restart ' +
            '`codebuddy --serve` to regenerate it, or pass --upstream-password.'
      );
    } else {
      add('upstream password', true, 'unknown (auth/status unavailable)');
    }

    const account = await probeAccount(config);
    const credentials = detectCredentials();
    const effective = effectiveCredential(credentials);

    if (account) {
      add(
        'agent signed in',
        account.signedIn,
        account.signedIn
          ? `yes (user "${account.userName}") - agent runs will produce output`
          : 'NO - the service is running but not signed in, so agent runs stay at "starting..." with no ' +
            'output. Sign in to CodeBuddy Code, or supply a credential (see the next check).'
      );
    } else {
      add('agent signed in', true, 'unknown (info unavailable)');
    }

    const credentialOk = Boolean(effective) || account?.signedIn === true;
    add(
      'agent credential',
      credentialOk,
      effective
        ? `${effective.method} from ${effective.source}` +
            (effective.envBased
              ? config.upstream.autoStart
                ? ' - forwarded to the spawned upstream'
                : ' - NOT forwarded: this gateway did not start the upstream, so the upstream process ' +
                  'must have the variable itself'
              : ' - read by the agent directly')
        : account?.signedIn === true
          ? 'not needed: the agent is signed in'
          : 'none found. Set CODEBUDDY_API_KEY (plus CODEBUDDY_INTERNET_ENVIRONMENT: unset for ' +
            'international, "internal" for China) or CODEBUDDY_AUTH_TOKEN, then start with --spawn-upstream.'
    );

    if (!credentialOk) {
      add(
        '→ to sign in',
        false,
        `run the bundled CLI interactively once and pick a login method: ${config.upstream.cliPath || 'codebuddy'} ` +
          '(choose "Log in via Chinese/International Site", then finish in the browser)'
      );
    }
  } else {
    add('upstream reachable', false, health.error || `HTTP ${health.status}: ${JSON.stringify(health.body)}`);
    if (!config.upstream.autoStart) {
      add('hint', false, 'start it with `codebuddy --serve`, or pass --spawn-upstream');
    }
  }

  if (!config.upstream.password) {
    add('gateway password', false, 'not found - it is generated by `codebuddy --serve` on first start');
  }

  const portFree = await isPortFree(config.host, config.port);
  add('gateway port', portFree, `${config.host}:${config.port} ${portFree ? 'is free' : 'is already in use'}`);

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}\n`);
  }
  process.stdout.write(`\n${JSON.stringify(describeConfig(config), null, 2)}\n`);
  return checks.every((c) => c.ok);
}

function isPortFree(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host === '0.0.0.0' ? undefined : host);
  });
}

async function serve(config, store, tokens, log) {
  const { server, supervisor } = createServer({ ...config, store, tokens });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  log.info(`wb-agent-gateway listening on ${config.host}:${config.port}`);
  log.info(`  MCP endpoint        ${config.publicUrl}/mcp`);
  log.info(`  OpenAI base URL     ${config.publicUrl}/v1`);
  log.info(`  resource metadata   ${config.publicUrl}/.well-known/oauth-protected-resource`);
  log.info(`  AS metadata         ${config.publicUrl}/.well-known/oauth-authorization-server`);
  log.info(`  upstream agent      ${config.upstream.baseUrl}`);
  log.info(`  OpenAI tools mode   ${config.openai.toolsMode}`);
  log.info(`  OpenAI permissions  ${config.openai.permissionMode}`);
  if (config.openai.toolsMode === 'ignore') {
    log.info('    -> declared tools are dropped; set --tools-mode translate to bridge function calling');
  }
  if (!config.accessCode) {
    log.warn('No accessCode configured: the consent screen is disabled and no new client can be approved.');
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    log.warn(`Binding to ${config.host} exposes a command-execution endpoint beyond loopback.`);
  }

  // Bring the upstream up in the background so the gateway starts serving immediately.
  supervisor
    .ensureRunning()
    .then(async (result) => {
      if (result.ok) {
        log.info(`upstream ready: ${result.detail}`);
        const status = await supervisor.status();
        if (status.credentials && status.credentials.authenticated !== true) {
          log.warn(
            'the upstream rejected our gateway password: every call will return 401. Delete ' +
              '~/.codebuddy/settings.json and restart the agent service to regenerate it.'
          );
        }
        if (status.account && status.account.signedIn === false) {
          const credential = effectiveCredential(detectCredentials());
          if (credential) {
            log.info(`no account session, but a credential is configured: ${credential.method} (${credential.source})`);
          } else {
            log.warn(
              'the agent is NOT signed in and no credential is configured: jobs will be accepted but stay at ' +
                '"starting..." with no output. Set CODEBUDDY_API_KEY (plus CODEBUDDY_INTERNET_ENVIRONMENT) or ' +
                'CODEBUDDY_AUTH_TOKEN, then restart with --spawn-upstream; or sign in with the codebuddy CLI.'
            );
          }
        }
      } else {
        log.warn(`upstream unavailable: ${result.detail}`);
      }
    })
    .catch((err) => log.error(`upstream startup failed: ${err.message}`));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    try {
      await supervisor.stop();
    } catch {
      /* best effort */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

// ------------------------------------------------------------------ launchd

function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function plistXml({ nodePath, scriptPath, configPath, dataDir, accessCode }) {
  const logDir = path.join(dataDir, 'logs');
  const env = {
    WB_AGENT_GATEWAY_CONFIG: configPath,
    ...(accessCode ? { WB_AGENT_GATEWAY_ACCESS_CODE: accessCode } : {})
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(dataDir)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'gateway.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'gateway.error.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function launchctl(args, { ignoreFailure = false } = {}) {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (ignoreFailure) return null;
    throw new Error(`launchctl ${args.join(' ')} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

function installService(config, log) {
  if (process.platform !== 'darwin') {
    throw new Error('install-service currently supports macOS (launchd) only.');
  }
  const scriptPath = path.resolve(process.argv[1]);
  const target = plistPath();
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;

  ensureDir(path.join(config.dataDir, 'logs'));
  ensureDir(path.dirname(target));

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    if (!existing.includes(SERVICE_LABEL)) {
      throw new Error(`Refusing to overwrite ${target}: it exists but was not created by this tool.`);
    }
  }

  atomicWrite(
    target,
    plistXml({
      nodePath: process.execPath,
      scriptPath,
      configPath: config.configPath,
      dataDir: config.dataDir,
      accessCode: config.accessCode
    })
  );

  launchctl(['bootout', `${domain}/${SERVICE_LABEL}`], { ignoreFailure: true });
  launchctl(['bootstrap', domain, target], { ignoreFailure: true });
  launchctl(['enable', `${domain}/${SERVICE_LABEL}`], { ignoreFailure: true });
  launchctl(['kickstart', '-k', `${domain}/${SERVICE_LABEL}`], { ignoreFailure: true });

  log.info(`installed launchd agent ${SERVICE_LABEL}`);
  log.info(`  plist   ${target}`);
  log.info(`  logs    ${path.join(config.dataDir, 'logs')}/gateway.log`);
  log.info(`  status  launchctl print ${domain}/${SERVICE_LABEL}`);
  if (config.accessCode) {
    log.warn('The approval passphrase is stored in the plist (mode 0600). Remove it with uninstall-service.');
  } else {
    log.warn('No accessCode is configured, so the consent screen is disabled and no new client can be approved.');
  }
}

function uninstallService(log) {
  if (process.platform !== 'darwin') {
    throw new Error('uninstall-service currently supports macOS (launchd) only.');
  }
  const target = plistPath();
  const uid = process.getuid?.() ?? 501;
  launchctl(['bootout', `gui/${uid}/${SERVICE_LABEL}`], { ignoreFailure: true });

  if (fs.existsSync(target)) {
    const content = fs.readFileSync(target, 'utf8');
    if (!content.includes(SERVICE_LABEL)) {
      throw new Error(`Refusing to delete ${target}: it was not created by this tool.`);
    }
    fs.unlinkSync(target);
    log.info(`removed ${target}`);
  } else {
    log.info('no launchd agent installed');
  }
}

// ---------------------------------------------------------------------- main

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help || argv._[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }

  const command = argv._[0] || 'serve';
  const { config, store, tokens } = buildContext(argv);
  const log = makeLogger(config.logLevel);

  switch (command) {
    case 'serve':
      await serve(config, store, tokens, log);
      return;

    case 'doctor': {
      const ok = await doctor(config, log);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    case 'print-config':
      printConfig(config, argv.client || 'generic');
      return;

    case 'clients': {
      const rows = Object.values(store.get('clients', {}));
      if (rows.length === 0) {
        process.stdout.write('No clients registered yet.\n');
        return;
      }
      for (const c of rows) {
        process.stdout.write(`${c.client_id}  ${String(c.client_name).padEnd(24)}  ${c.redirect_uris.join(', ')}\n`);
      }
      return;
    }

    case 'rm-client': {
      const id = argv._[1];
      if (!id) {
        process.stderr.write('Usage: wb-agent-gateway rm-client <client_id>\n');
        process.exitCode = 2;
        return;
      }
      const clients = { ...store.get('clients', {}) };
      if (!clients[id]) {
        process.stderr.write(`Unknown client: ${id}\n`);
        process.exitCode = 1;
        return;
      }
      delete clients[id];
      store.set('clients', clients);
      process.stdout.write(`Removed ${id}. Existing tokens remain valid until they expire or are revoked.\n`);
      return;
    }

    case 'install-service':
      installService(config, log);
      return;

    case 'uninstall-service':
      uninstallService(log);
      return;

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});

export { parseArgs, buildContext, printConfig, doctor, isPortFree, serve, installService, uninstallService, HELP };
