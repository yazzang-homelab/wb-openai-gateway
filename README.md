# wb-agent-gateway

## Why this gateway

A WorkBuddy / CodeBuddy account gives you models (GPT-5.5 and others) and a coding agent, but only inside the
WorkBuddy app or the `codebuddy` CLI. The HTTP API of `codebuddy --serve` is guarded by a shared password and a
browser cookie and does not speak OpenAI, so no other tool can connect to it.

This gateway fills that gap.

- **Use the account you already have, from other tools.** Clients that only take a `base_url` + `api_key` — OpenAI SDKs, `curl`, GJC — connect unchanged.
- **One token per client.** Instead of handing out the shared password, each device gets a scoped, individually revocable OAuth token.
- **Client-side tool loops.** In `translate` mode the agent's decisions come back as real `tool_calls`, so a client like GJC runs tools on its own machine.
- **Defaults that do not stall.** An OpenAI request cannot answer a permission prompt, so the default permission mode is `dontAsk`.
- **Always on.** It spawns, supervises and restarts `codebuddy --serve` itself.

**When it is the wrong tool.** If you already have a provider API key, call the provider directly. Every turn creates
and stops one agent job, so it is slower; in `translate` mode the stream arrives only once the answer is complete;
and token usage is an estimate.

> **This repository** packages the gateway for its OpenAI-compatible API (`/v1`) use.
> Guides: [English](docs/en/guide.md) · [한국어](docs/ko/guide.md) ·
> Appendix: [attach to GJC](docs/en/gjc.md) / [GJC 연결](docs/ko/gjc.md) ·
> Example: [`examples/gjc-models.yml`](examples/gjc-models.yml) · Site: built by `.github/workflows/pages.yml`.
> Linux: `deploy/wb-agent-gateway.service`, headless tokens: `tools/get-token.mjs`.


An **OAuth 2.0 protected gateway** in front of the local WorkBuddy / CodeBuddy agent, speaking
**two client protocols**:

* **MCP** (Streamable HTTP) for MCP-capable agents — `/mcp`
* **OpenAI Chat Completions** for everything else — `/v1`

WorkBuddy ships a full coding agent (the bundled `CodeBuddy Code` CLI) and can serve it over HTTP
with `codebuddy --serve`. That HTTP API is protected by a shared **password** and a
`gateway_session` cookie — fine for a browser, useless for another agent. Nothing in the product
speaks OAuth *as a server*, so no external agent can connect to it.

This gateway adds the missing piece: MCP + OpenAI on the front, the product's HTTP API on the back,
and one revocable, scoped OAuth token per client.

```
        other agents                          wb-agent-gateway                     local agent
┌────────────────────────┐        ┌────────────────────────────────────┐        ┌──────────────────┐
│ MCP clients            │        │  OAuth 2.0 authorization server    │        │ codebuddy        │
│  Claude / Cursor / Zed │──MCP──▶│  MCP resource server   (/mcp)      │──HTTP─▶│ --serve          │
│                        │ Bearer │  OpenAI-compatible API (/v1)       │        │ 127.0.0.1:8399   │
│ OpenAI clients         │──HTTP─▶│  ACP passthrough       (/acp)      │        │ (password auth)  │
│  SDKs / scripts / UIs  │        │  upstream supervisor               │        └──────────────────┘
└────────────────────────┘        └────────────────────────────────────┘
             └──── 401 + resource_metadata ────┘   discovery, DCR, PKCE, consent, token
```

## Endpoints

| Spec / API | Endpoint |
|------|----------|
| RFC 9728 Protected Resource Metadata | `GET /.well-known/oauth-protected-resource[/mcp]` |
| RFC 8414 Authorization Server Metadata | `GET /.well-known/oauth-authorization-server` |
| RFC 7591 Dynamic Client Registration | `POST /register` |
| RFC 6749 + RFC 7636 Authorization Code + PKCE (S256) | `GET/POST /authorize`, `POST /token` |
| RFC 7009 Token Revocation | `POST /revoke` |
| MCP Streamable HTTP | `POST /mcp`, `GET /mcp` (SSE), `DELETE /mcp` |
| OpenAI Models | `GET /v1/models`, `GET /v1/models/:id` |
| OpenAI Tools (MCP catalog as function schemas) | `GET /v1/tools` |
| OpenAI Chat Completions | `POST /v1/chat/completions` (streaming + buffered, optional function calling) |
| OpenAI legacy Completions | `POST /v1/completions` |
| ACP-over-SSE passthrough | `ANY /acp/*` → upstream `/api/v1/acp/*` |
| Health | `GET /health` |

Because the gateway answers unauthenticated requests with
`401` + `WWW-Authenticate: Bearer resource_metadata="…"`, a compliant MCP client discovers the
authorization server and runs the whole flow **without any manual configuration**.

## Install

Node.js 18.17+ is required. There are **no runtime dependencies**.

```bash
cd wb-agent-gateway
npm install          # optional, only for the wire-compatibility tests
```

## Quick start

```bash
export WB_AGENT_GATEWAY_ACCESS_CODE="$(openssl rand -base64 24)"   # the consent passphrase
node bin/wb-agent-gateway.js serve --spawn-upstream
```

```
wb-agent-gateway listening on 127.0.0.1:8931
  MCP endpoint        http://127.0.0.1:8931/mcp
  OpenAI base URL     http://127.0.0.1:8931/v1
  resource metadata   http://127.0.0.1:8931/.well-known/oauth-protected-resource
  AS metadata         http://127.0.0.1:8931/.well-known/oauth-authorization-server
  upstream agent      http://127.0.0.1:8399
starting upstream agent service: .../cli/bin/codebuddy --serve --port 8399
upstream ready: started on port 8399 (pid 41207)
```

`--spawn-upstream` makes the gateway start, health-check, supervise and restart the agent service
itself, and adopt the gateway password the CLI generates on first start. Drop the flag if you
prefer to run `codebuddy --serve` (or `codebuddy daemon start`) yourself.

Then point a client at it:

```bash
node bin/wb-agent-gateway.js print-config --client claude    # mcp / openai / claude / cursor / vscode / generic
```

On first connect the client registers itself, opens the consent page in your browser, and asks for
the approval passphrase. Approve it and the client receives an access token plus a refresh token.

### MCP client

```json
{ "mcpServers": { "workbuddy": { "type": "http", "url": "http://127.0.0.1:8931/mcp" } } }
```

### OpenAI client

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8931/v1", api_key="<access token>")
client.chat.completions.create(model="workbuddy", messages=[{"role": "user", "content": "..."}])
```

## Agent credentials — why runs stay at `starting…`

There are **three independent authentication layers**, and conflating them is the most common
source of confusion:

| Layer | What it protects | Where it lives |
|-------|------------------|----------------|
| **OAuth token** | your clients → this gateway | issued by the consent flow |
| **Gateway password** | this gateway → the local agent service | `~/.codebuddy/settings.json` → `gateway.password` |
| **Agent credential** | the agent → its model backend | see below |

Only the third one lets a run actually produce output. Without it a job is accepted, sits at
`starting…` forever, and the gateway eventually returns an empty answer with
`finish_reason: "length"`.

The CLI resolves its credential in this priority order:

| Priority | Method | How to supply it |
|:--------:|--------|------------------|
| 1 | `CODEBUDDY_AUTH_TOKEN` | OAuth token, e.g. reused from CI |
| 2 | `apiKeyHelper` | enterprise OAuth helper script, set in `~/.codebuddy/settings.json` |
| 3 | `CODEBUDDY_API_KEY` | static API key for personal use or third-party model services |

`CODEBUDDY_API_KEY` **requires** `CODEBUDDY_INTERNET_ENVIRONMENT` to match your edition —
unset for International, `internal` for China, plus `ioa`, `cloudhosted`, `selfhosted`.

A spawned upstream inherits the gateway's environment, so `--spawn-upstream` is all you need:

```bash
export CODEBUDDY_API_KEY="your-api-key"
export CODEBUDDY_INTERNET_ENVIRONMENT="internal"     # omit for International
node bin/wb-agent-gateway.js serve --spawn-upstream
```

```
upstream ready: started on port 8399 (pid 41207)
no account session, but a credential is configured: CODEBUDDY_API_KEY (environment)
```

Without `--spawn-upstream` the variables are **not** forwarded: the upstream process you started
separately must have them itself. `doctor` says so explicitly, and `upstream.env` in the config
file adds variables for the spawned child.

The alternative is to sign in interactively with the bundled CLI — that session is read from
`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth` and needs no environment
variable.

### How to sign in

Run the bundled CLI **once, interactively**, and complete the browser flow:

```bash
"/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
```

On first launch it shows a login method picker:

```
Select login method:
› Log in via Chinese Site
  Log in via International Site
  Log in via Enterprise Domain
  Log in via iOA (Tencent only)
```

Pick with `↑`/`↓` + `Enter`; the browser opens and finishes the OAuth handshake. The session is
then on disk and every later `codebuddy --serve` (including one this gateway spawns) picks it up —
no environment variable needed. `doctor` reports it as `agent signed in`.

> The desktop app's session is **not** shared with CLI subprocesses, so being signed in to
> WorkBuddy does not sign in the agent. `doctor` prints the exact command under `→ to sign in`
> whenever neither a session nor a credential is present.

## OpenAI compatibility

```bash
curl -N http://127.0.0.1:8931/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"workbuddy","stream":true,
       "messages":[{"role":"user","content":"Summarise this repo"}],
       "workbuddy":{"cwd":"/Users/me/project","timeoutSeconds":300}}'
```

| Model id | Agent mode | Notes |
|----------|-----------|-------|
| `workbuddy` | `cli` | Default: full tool access (read, write, bash, MCP, skills) |
| `workbuddy-ptc` | `ptc` | Programmatic tool calling — composes multi-step work in one script |
| `workbuddy-minimal` | `minimal` | Sandbox REPL only, no MCP or file tools |

**Backend model by id.** List backend models in `openai.backendModels` (e.g. `["gpt-6-sol", "kimi-k3"]`)
and each is exposed as `<pseudo-model>:<backend>` — `workbuddy:gpt-6-sol`, `workbuddy-ptc:kimi-k3`. The
request is dispatched with that backend model, so clients that can only set `model` still choose it.
An id whose backend is not listed is treated like any unknown id.

Any unknown model id (e.g. `gpt-4o-mini`) falls back to the default agent and is **echoed back**
unchanged, so clients with hard-coded model names work without reconfiguration.

**Non-standard extension.** Pass a `workbuddy` object to control the run:

```json
{ "workbuddy": { "cwd": "/repo", "agent": "cli", "permissionMode": "acceptEdits",
                 "effort": "high", "model": "claude-sonnet-4-20250514", "name": "nightly",
                 "timeoutSeconds": 300 } }
```

`permissionMode` is one of `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`,
`bypassPermissions`; `effort` is one of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
(standard `reasoning_effort` maps onto it). Other values are rejected with `400` before a job is
dispatched.

`timeoutSeconds` (default 300, max 1800) bounds how long the gateway waits before returning the
partial answer with `finish_reason: "length"`.

**Job lifecycle.** An OpenAI request is stateless, so the gateway never leaves a job behind: a job
that times out, or whose client disconnects, is stopped. A job that stops to wait for input
(`state: "blocked"`, typically a permission prompt) is stopped too; if it produced no text the
request fails with `409 agent_needs_input`. Because an OpenAI request cannot answer a prompt, a job
that omits `workbuddy.permissionMode` runs with the gateway's `openai.permissionMode` (default
`dontAsk`: pre-approved and safe actions run, anything needing approval is denied instead of
prompting). Override it per request, change it with `--permission-mode`, or use `agent_run` over
`/mcp` and answer with `agent_job_reply`.

**How the translation works.** The upstream agent is asynchronous: `POST /api/v1/jobs` returns a job
id and the answer accumulates in the job transcript. The gateway bridges that to a synchronous HTTP
response (or an SSE stream) by polling the transcript and emitting the delta as it grows — so
`stream: true` produces real incremental chunks, not one buffered blob.

### Tool calling

The upstream is an autonomous agent, not a raw model: it runs its own tool loop (bash, file I/O,
MCP servers, skills) and cannot natively *return* a tool call instead of executing it. The gateway
can bridge the two formats — `openai.toolsMode` selects the behaviour:

| Mode | Behaviour |
|------|-----------|
| `ignore` (default) | `tools` is accepted and dropped; the agent answers in text. Every response carries `X-WorkBuddy-Tools-Ignored: 1`. |
| `reject` | A request declaring `tools` fails fast with `400 tools_not_supported`, so a framework that requires `tool_calls` does not silently loop. |
| `translate` | Full bridge — OpenAI function calling over the agent. |

#### `translate`: OpenAI function calling over the agent

```
client tools ──▶ tool protocol in the prompt ──▶ agent reply
                                                      │
client ◀── tool_calls ◀── parsed envelope ◀───────────┘
```

1. The declared schemas are rendered into the prompt as a protocol:
   `{"wb_tool_call": {"name": "...", "arguments": { ... }}}`
2. The agent replies with plain text, or with that envelope.
3. The gateway parses it and returns a real OpenAI response:

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_9fQ2x...",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"Seoul\"}" }
      }]
    }
  }]
}
```

4. The client runs the tool and sends the result back as a `role: "tool"` message; the gateway
   replays it into the conversation so the loop continues normally.

**Safety.** A reply is only treated as a tool call when its name matches one of the *declared*
tools. An answer that merely contains JSON — a code sample, an example payload — stays text. This
is covered by tests.

**`tool_choice`** is honoured: `"none"` disables the bridge for that request, `"auto"` is the
default, and `"required"` / `{"type":"function","function":{"name":...}}` are expressed to the
agent as an instruction. It is a prompt, not a decoder constraint, so compliance is best-effort.

**Streaming is buffered in `translate` mode.** A reply can only be classified as text or tool call
once it is complete, so content deltas are not emitted incrementally. The SSE frames are still
correct: either content chunks, or one `tool_calls` delta followed by
`finish_reason: "tool_calls"`. Because a run can take minutes, the gateway writes an SSE
`: keepalive` comment every 15 seconds so proxies and clients do not drop an apparently idle
stream.

**Tolerance.** The parser accepts the documented envelope, a fenced code block around it, prose
around it, a bare `{name, arguments}` object, and an OpenAI-shaped `tool_calls` payload. Arguments
may be an object or a JSON string.

#### Exposing the agent's own tools

`GET /v1/tools` renders the gateway's MCP tool catalog as OpenAI function schemas so a client can
discover what the agent offers:

```json
{ "object": "list", "source": "mcp",
  "data": [{ "type": "function",
             "function": { "name": "agent_run", "description": "...", "parameters": { ... } } }],
  "mcpEndpoint": "http://127.0.0.1:8931/mcp" }
```

These are *gateway-side* tools: the agent already uses them internally, so calling them back
through `/v1` is not meaningful. **When the calling agent must drive the tool loop, use `/mcp`** —
11 explicit tools, no prompt trickery. Use `/v1` with `translate` when the caller brings its own
tools.

**Other accepted-but-ignored fields.** `temperature`, `top_p`, `max_tokens`, `stop` are validated
for shape but ignored: the agent runs its own model configuration. Image parts in `content` are
collapsed to `[image omitted]`. `usage` is a character-based estimate, not a real token count.

## Tools exposed over MCP

| Tool | Scope | Purpose |
|------|-------|---------|
| `agent_health` | `agent:read` | Reachability, credential acceptance, sign-in state |
| `agent_info` | `agent:read` | Version, OS, CWD, uptime |
| `agent_run` | `agent:run` | Run a prompt; optionally wait. A job waiting for input returns `needsReply: true` |
| `agent_job_status` | `agent:read` | Job lifecycle state + transcript |
| `agent_job_stop` | `agent:run` | Stop a running job |
| `agent_job_reply` | `agent:run` | Reply to a job waiting for input (`state: "blocked"`) |
| `agent_jobs_list` | `agent:read` | List background jobs |
| `agent_sessions_list` | `agent:read` | List conversation sessions |
| `agent_workers_list` | `agent:read` | List worker processes and their endpoints |
| `agent_worker_logs` | `agent:read` | Read telemetry / process / debug / transcript logs |
| `agent_dispatch_context` | `agent:read` | Default CWD, agent modes, permission mode |

Scopes are enforced twice: `tools/list` only advertises tools the token can actually call, and
`tools/call` re-checks and returns a `Permission denied` tool result on mismatch. The OpenAI surface
requires `agent:run` for completions and `agent:read` for `/v1/models`. The `/acp` passthrough
carries prompts, so it requires `agent:run`.

## CLI

```
wb-agent-gateway serve             start the gateway (default command)
wb-agent-gateway doctor            check config, upstream, credentials, sign-in and port
wb-agent-gateway print-config      emit client config (mcp / openai / claude / cursor / vscode / generic)
wb-agent-gateway clients           list dynamically registered clients
wb-agent-gateway rm-client <id>    forget a registered client
wb-agent-gateway install-service   run persistently via launchd (macOS)
wb-agent-gateway uninstall-service remove the launchd agent
```

`doctor` distinguishes the four things that are easy to confuse:

```
ok    upstream reachable   {"status":"ok","uptime":251.2,"platforms":["generic","wecom","wechat-kf"]}
ok    upstream password    accepted by the agent service
FAIL  agent signed in      NO - the service is running but not signed in, so agent runs stay at
                           "starting..." with no output. Sign in to CodeBuddy Code, or supply a
                           credential (see the next check).
FAIL  agent credential     none found. Set CODEBUDDY_API_KEY (plus CODEBUDDY_INTERNET_ENVIRONMENT:
                           unset for international, "internal" for China) or CODEBUDDY_AUTH_TOKEN,
                           then start with --spawn-upstream.
ok    gateway port         127.0.0.1:8931 is free
FAIL  access code          NOT SET - the consent screen refuses every client until one is configured
```

* **Reachable** — the HTTP API answers.
* **Password accepted** — the gateway password we hold clears the upstream's own check
  (`/api/v1/auth/status`). This says nothing about the account.
* **Signed in** — the agent has a CodeBuddy account session (`/api/v1/info` exposes the resolved
  user name). An unsigned agent still accepts jobs; they simply never leave `starting…`.
* **Credential** — a model credential is configured, and whether it will actually reach the agent
  (environment variables only reach it if this gateway spawned it).

## Persistent operation (macOS)

```bash
node bin/wb-agent-gateway.js install-service     # writes ~/Library/LaunchAgents/ai.workbuddy.agent-gateway.plist
node bin/wb-agent-gateway.js uninstall-service   # boots it out and removes only that file
launchctl print gui/$UID/ai.workbuddy.agent-gateway
```

`install-service` refuses to overwrite a plist it did not create, and `uninstall-service` refuses to
delete one it does not own. Logs land in `<dataDir>/logs/gateway.log`. The approval passphrase is
stored in the plist (mode `0600`) so the service does not depend on your shell environment.

## Configuration

Precedence: **CLI flags > environment variables > config file > defaults**.
The config file is `~/.wb-agent-gateway/config.json` (see `config.example.json`).

| Flag | Env | Default |
|------|-----|---------|
| `--host` | `WB_AGENT_GATEWAY_HOST` | `127.0.0.1` |
| `--port` | `WB_AGENT_GATEWAY_PORT` | `8931` |
| `--public-url` | `WB_AGENT_GATEWAY_PUBLIC_URL` | `http://<host>:<port>` |
| `--access-code` | `WB_AGENT_GATEWAY_ACCESS_CODE` | none |
| `--data-dir` | `WB_AGENT_GATEWAY_DATA_DIR` | `~/.wb-agent-gateway` |
| `--upstream-url` | `CODEBUDDY_GATEWAY_URL` | auto-discovered, else `http://127.0.0.1:<serve-port>` |
| `--upstream-password` | `CODEBUDDY_GATEWAY_PASSWORD` | read from `~/.codebuddy/settings.json` |
| `--spawn-upstream` | `WB_AGENT_GATEWAY_SPAWN_UPSTREAM` | off |
| `--serve-port` | `CODEBUDDY_SERVE_PORT` | `8399` |
| `--tools-mode` | `WB_AGENT_GATEWAY_TOOLS_MODE` | `ignore` (or `reject`, `translate`) |
| `--permission-mode` | `WB_AGENT_GATEWAY_PERMISSION_MODE` | `dontAsk` (OpenAI jobs without `workbuddy.permissionMode`) |
| `--cli-path` | `CODEBUDDY_CLI_PATH` | bundled WorkBuddy CLI |
| `--config` | `WB_AGENT_GATEWAY_CONFIG` | `~/.wb-agent-gateway/config.json` |

A spawned upstream inherits the gateway's environment, so `CODEBUDDY_API_KEY` and
`CODEBUDDY_INTERNET_ENVIRONMENT` reach it. `upstream.env` in the config file adds more.

## Security

A token minted here can run shell commands and read/write files as your user, because that is
exactly what the local agent does. Treat the gateway as a privileged service.

* **Binds to loopback by default.** If you bind elsewhere the startup log warns loudly. Put it
  behind a TLS-terminating tunnel and set `publicUrl` to the public HTTPS URL.
* **The consent screen is the human gate.** Every new client must be approved with the
  `accessCode`. Failed attempts are rate-limited per client. With no `accessCode` set the consent
  screen is disabled (`503`) and no client can be approved — `doctor` flags this as `FAIL`.
* **Host header is checked.** Requests are only served for the `publicUrl` host and for
  `127.0.0.1` / `localhost` / `[::1]` on the listening port; anything else gets `421`. This stops a
  web page from reaching the gateway through DNS rebinding.
* **PKCE S256 is mandatory.** Plain `code_challenge_method` is rejected.
* **Short-lived access tokens, rotating refresh tokens.** Refresh tokens are single-use: each
  refresh returns a new one, and reusing an old one fails.
* **Revocation is real.** `POST /revoke` puts the token's `jti` on a persisted deny-list, so the
  token dies immediately even though it is self-contained.
* **Scopes are enforced server-side** on both the MCP and OpenAI surfaces.
* Access tokens are HMAC-SHA256 signed with a key generated into `<dataDir>/secret.key`
  (mode `0600`); they survive restarts without a database.

### Files written

```
~/.wb-agent-gateway/
  secret.key     HMAC signing key (0600)
  state.json     registered clients, refresh tokens, revoked ids, consent audit trail
  logs/          only when installed as a service
```

`rm -rf ~/.wb-agent-gateway` resets everything and invalidates all issued tokens.

## Tests

Start an upstream agent first, then:

```bash
npm test                      # all four suites
npm run test:bridge           # tool bridge, stub upstream  (73 checks)
npm run test:e2e              # raw HTTP                   (90 checks)
npm run test:mcp              # MCP SDK client             (21 checks)
npm run test:openai           # OpenAI SDK client          (15 checks)
```

| Suite | What it proves |
|-------|----------------|
| `test/tool-bridge.mjs` | Runs the gateway against a **stub upstream** so the whole function-calling path is deterministic: tool schemas reach the prompt, an envelope comes back as real `tool_calls`, undeclared tools are refused, `tool_choice` is honoured, streaming frames are correct, and `ignore` mode still passes the reply through as text. Also unit-tests the parser and `toPrompt`. |
| `test/e2e.mjs` | Raw HTTP: discovery, 401 challenge, DCR validation, PKCE, single-use codes, refresh rotation, revocation, scope enforcement, JSON-RPC error codes, SSE transport, and the OpenAI surface (models, buffered, streaming, `include_usage`, legacy completions, error shapes, both `toolsMode` behaviours) |
| `test/mcp-sdk-client.mjs` | Drives the **official `@modelcontextprotocol/sdk` client** through the real flow: `connect` → `UnauthorizedError` → discovery → dynamic registration → consent → code → token → reconnect → `listTools` → `callTool` |
| `test/openai-client.mjs` | Drives the **official `openai` Node SDK**: `models.list`, buffered and streamed `chat.completions`, and typed 401/403 errors |

The SDK suites skip cleanly (exit 0) when their optional dev dependency is absent. Each suite starts
its own gateway on ports 8932–8934 and expects the upstream agent on 8399.

## Local model stub (`tools/mock-model.mjs`)

A mock OpenAI-compatible model server, for exercising the stack without a model account:

```bash
node tools/mock-model.mjs --port 8099 --answer "hello from the mock"
```

Point the bundled CLI at it:

```bash
CODEBUDDY_API_KEY=test-key \
CODEBUDDY_BASE_URL=http://127.0.0.1:8099/v1 \
CODEBUDDY_MODEL=mock-model \
codebuddy --serve --port 8399
```

It logs every request, and can emit a tool-call envelope to exercise the bridge:

```bash
node tools/mock-model.mjs --tool get_weather --args '{"city":"Seoul"}'
```

### What this does and does not prove

Verified with it:

* the CLI **does** honour `CODEBUDDY_BASE_URL` — it issued `GET /v1/models` against the stub, so
  third-party model routing works as documented in `iam.md`.

Not verified — and why: the stub received no `POST /v1/chat/completions`. The model **catalog**
the CLI resolves against comes from its product configuration, not from `CODEBUDDY_BASE_URL`;
`CODEBUDDY_MODEL` only selects within that catalog. With no credential the catalog cannot be
fetched, so a dispatched job parks at `starting…` and never reaches the model. **A credential is
therefore genuinely required** for a run to produce output — see
[Agent credentials](#agent-credentials--why-runs-stay-at-starting).

### Environment caveats

Two things bit us while building this and are worth knowing:

* **Sandboxed shells can break job dispatch.** The agent writes `~/.codebuddy/jobs/<id>/state.json`
  via a temp-file rename. A sandbox that permits the write but blocks the rename surfaces as
  `EPERM: operation not permitted, rename ... state.json.<pid>.tmp`. Run the CLI normally.
* **Stale job runners poison later attempts.** A stuck job subprocess keeps the pid that owns the
  state file, so every later dispatch fails against it. Check for leftovers with
  `pgrep -f -- "--session-id"` and clear them before retrying.
* **A stale `CODEBUDDY_SERVICE_PROXY_URL`** (injected by a parent sandbox) makes the HTTP API answer
  `proxy overloaded` instead of JSON. Launch the CLI with a clean environment if you see that.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Cannot reach the local agent service` | Upstream not running. Use `--spawn-upstream`, or start `codebuddy --serve`, or fix `--upstream-url`. |
| `401 AUTH_REQUIRED` from upstream | Wrong gateway password. Run `doctor`; the password lives in `~/.codebuddy/settings.json`. Delete that file and restart the service to regenerate it. |
| Client connects but tools never appear | The consent page was never approved, or the token has no scopes. Check `clients` and the gateway log. |
| `agent_run` or chat returns empty content and `finish_reason: "length"` | The agent has no model credential. Check `agent signed in` and `agent credential` in `doctor`, then see [Agent credentials](#agent-credentials--why-runs-stay-at-starting). |
| `agent credential` says "NOT forwarded" | The upstream was started outside this gateway, so it needs the variable itself. Restart with `--spawn-upstream`, or export it in the upstream's own environment. |
| My framework never gets `tool_calls` | Set `--tools-mode translate` to bridge OpenAI function calling onto the agent. `ignore` (the default) drops `tools` and answers in text — see [Tool calling](#tool-calling). |
| `translate` mode returns text instead of a tool call | The agent did not emit the envelope, or it named a tool the client never declared (which is refused by design). Check the gateway log; a stronger instruction is to use `tool_choice: {"type":"function","function":{"name":"..."}}`. |
| Client refuses to start the OAuth flow | Set `publicUrl` to an HTTPS URL (some clients require HTTPS outside loopback), or pin the endpoints via `print-config --client generic`. |
| Streaming stops immediately | The client disconnected; the gateway stops the upstream job. Check the gateway log. |
| `409 agent_needs_input` | The agent stopped at a permission prompt or question and had no answer yet. Keep `openai.permissionMode` non-prompting (`dontAsk`, the default), set `workbuddy.permissionMode`, or drive it over `/mcp` with `agent_job_reply`. |
| `421 invalid_host` | The request's `Host` is not the `publicUrl` host or loopback. Set `publicUrl` to the URL clients actually use. |

## Why not just use `--auth none`?

`codebuddy --serve --auth none` disables authentication entirely: any process on the machine — and
any web page that can reach the port — can execute commands and read/write files. This gateway is
the alternative: a single, revocable, scoped, auditable credential per client, with a human
approving each one.
