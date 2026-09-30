# wb-openai-gateway guide

[README](../../README.md) · [한국어](../ko/guide.md) · [Appendix: attach to GJC](gjc.md)

A gateway that exposes the WorkBuddy / CodeBuddy agent as an **OpenAI-compatible API (`/v1`)**.
Any client that only takes a `base_url` and an `api_key` — the OpenAI SDKs, `curl`, GJC — works unchanged.

```
OpenAI client ──Bearer──▶ wb-agent-gateway (/v1) ──password──▶ codebuddy --serve ──▶ model backend
 (SDK · curl · GJC)        127.0.0.1:8931                     127.0.0.1:8399
```

The gateway also ships an MCP endpoint (`/mcp`); this guide covers the OpenAI API path only.

## 1. Three authentication layers

| Layer | Protects | Where it lives |
| --- | --- | --- |
| OAuth access token | client → gateway | issued by the consent flow (`tools/get-token.mjs`) |
| Gateway password | gateway → `codebuddy --serve` | `gateway.password` in `~/.codebuddy/settings.json` (automatic) |
| Agent credential | agent → model backend | `CODEBUDDY_API_KEY` or `CODEBUDDY_AUTH_TOKEN` |

Without the third, a job parks at `starting…` and eventually returns an empty answer with
`finish_reason: "length"`. `CODEBUDDY_API_KEY` needs `CODEBUDDY_INTERNET_ENVIRONMENT` to match the
account edition (unset for International, `internal` for China).

## 2. Install (Linux)

Node.js 18.17+ is required. The gateway itself has no runtime dependencies.

Run it as a dedicated user: the agent's file and shell tools execute with that user's rights.

```bash
useradd -m -s /bin/bash wbagent
runuser -u wbagent -- bash -lc '
  mkdir -p ~/.local ~/wb-agent-work
  npm install --prefix ~/.local/codebuddy @tencent-ai/codebuddy-code
  git clone <this repo> ~/.local/wb-agent-gateway
'
```

### Credentials file

`/home/wbagent/.local/wb-agent-gateway/.env` (mode `600`, never commit it):

```ini
CODEBUDDY_API_KEY=your-key
# CODEBUDDY_INTERNET_ENVIRONMENT=internal   # China edition only
WB_AGENT_GATEWAY_ACCESS_CODE=value-from-openssl-rand-base64-24
```

`WB_AGENT_GATEWAY_ACCESS_CODE` is the passphrase that approves new clients. Without it the consent
screen is disabled and no new client can be approved.

### Config file

`/home/wbagent/.wb-agent-gateway/config.json`:

```json
{
  "host": "127.0.0.1",
  "port": 8931,
  "publicUrl": "http://127.0.0.1:8931",
  "accessTokenTtl": 2592000,
  "upstream": {
    "autoStart": true,
    "discover": false,
    "servePort": 8399,
    "cliPath": "/home/wbagent/.local/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy"
  },
  "openai": {
    "toolsMode": "translate",
    "permissionMode": "dontAsk",
    "backendModels": ["gpt-5.5", "gpt-5.4"]
  }
}
```

- `upstream.autoStart: true` — the gateway spawns, health-checks and restarts `codebuddy --serve`
  itself, and the credentials in `.env` reach the child process.
- `openai.backendModels` — each backend listed here appears in `/v1/models` as `workbuddy:<backend>`
  and so on. List only models your account can use.
- `openai.toolsMode` and `openai.permissionMode` are explained in sections 5 and 6.

### Service

Adapt `deploy/wb-agent-gateway.service` to your paths. The built-in `install-service` command covers
macOS (launchd) only.

```bash
cp deploy/wb-agent-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wb-agent-gateway
journalctl -u wb-agent-gateway -n 20 --no-pager
```

A healthy start logs `OpenAI base URL`, `OpenAI permissions  dontAsk` and `upstream ready`.
`node bin/wb-agent-gateway.js doctor` (run as `wbagent`) checks credentials and the upstream.

### Network exposure

Binding `host` beyond loopback **exposes a command-execution endpoint** to that network (the start
log warns about it). Keep it on a private network such as Tailscale or behind an HTTPS reverse proxy;
never open it to the public internet. `publicUrl` must match the URL clients actually use, otherwise
requests fail with `421 invalid_host`.

## 3. Issue a token

For headless clients, `tools/get-token.mjs` runs dynamic registration → PKCE approval → code exchange
in one go. The token goes to stdout only, so capture it straight into a file.

```bash
runuser -u wbagent -- env HOME=/home/wbagent \
  node /home/wbagent/.local/wb-agent-gateway/tools/get-token.mjs \
  --url http://127.0.0.1:8931 --name my-laptop > ~/.config/wb-agent-token
chmod 600 ~/.config/wb-agent-token
```

- The approval passphrase is read from `WB_AGENT_GATEWAY_ACCESS_CODE` or the config's `accessCode`.
- Issue one token per device. `clients` lists registrations and `rm-client <id>` removes one.
  **Run `rm-client` with the service stopped:** a running gateway rewrites `state.json` from memory and undoes the removal.
  Issued tokens stay valid until they expire or are revoked via `/revoke`, so keep `accessTokenTtl` modest.

## 4. First calls

```bash
TOKEN=$(cat ~/.config/wb-agent-token)
curl -s http://127.0.0.1:8931/v1/models -H "Authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:8931/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"workbuddy:gpt-5.5","messages":[{"role":"user","content":"Reply with OK"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8931/v1", api_key=TOKEN)
client.chat.completions.create(model="workbuddy:gpt-5.5",
                               messages=[{"role": "user", "content": "Reply with OK"}])
```

### Model ids

| Model id | Agent mode | Notes |
| --- | --- | --- |
| `workbuddy` | `cli` | Default. The agent has its own tools (read, write, bash, MCP, skills) |
| `workbuddy-ptc` | `ptc` | Composes multi-step work into one script |
| `workbuddy-minimal` | `minimal` | Sandbox REPL only, no file or MCP tools |

Append `:<backend>` to run on that backend model (it must be in `backendModels`). Unknown ids fall
back to the default agent and are echoed back unchanged.

### Standard fields

- `stream: true` is supported; long runs get an SSE keepalive every 15 seconds.
- `reasoning_effort` is forwarded as the agent's effort (`minimal` … `max`).
- `temperature`, `top_p`, `max_tokens`, `stop` are shape-checked and ignored. Image parts become `[image omitted]`.
- `usage` is a character-based estimate.

### The `workbuddy` extension

```json
{ "workbuddy": { "cwd": "/repo", "permissionMode": "acceptEdits", "effort": "high",
                 "name": "nightly", "timeoutSeconds": 600 } }
```

After `timeoutSeconds` (default 300, max 1800) the gateway stops the job and returns the partial
answer with `finish_reason: "length"`.

## 5. Permission mode (`409 agent_needs_input`)

When the agent waits for a permission decision before using one of its own tools (`blocked`), an
OpenAI request has no way to answer it. The gateway stops the job and, if nothing was answered yet,
returns `409 agent_needs_input`.

So a request without `workbuddy.permissionMode` runs with the gateway's `openai.permissionMode`
(default `dontAsk`).

| Mode | Behaviour |
| --- | --- |
| `dontAsk` (default) | Never prompts; runs pre-approved and safe actions, denies anything requiring approval |
| `acceptEdits` | File edits are accepted automatically; other approvals still wait |
| `bypassPermissions` | Everything is allowed: anyone who can reach the gateway can run commands on the host |
| `plan` | Analyses only; no file edits or commands |
| `default` | Prompts on first use of each tool; ends in 409 on the OpenAI path |
| `auto` | An AI classifier reviews actions; can still end in 409 when it asks |

Precedence: request `workbuddy.permissionMode` → `--permission-mode` →
`WB_AGENT_GATEWAY_PERMISSION_MODE` → config `openai.permissionMode`. Invalid values fail at start.

## 6. Function calling (`openai.toolsMode`)

The agent executes tools itself, so natively it cannot return "please call this tool"
(`tool_calls`). `toolsMode` bridges that gap.

| Mode | Behaviour |
| --- | --- |
| `ignore` (default) | Drops `tools` and answers in text; flags `X-WorkBuddy-Tools-Ignored: 1` |
| `reject` | A request with `tools` fails with `400 tools_not_supported` |
| `translate` | Declared schemas go into the prompt; the agent's call envelope comes back as real `tool_calls` |

Clients that run their own tool loop, such as GJC, need `translate`.

- A reply counts as a tool call only when the name matches a declared tool; example JSON stays text.
- In `translate` a reply can only be classified once complete, so the stream arrives at the end.
- `tool_choice` `required` or a named function is passed as an instruction, not enforced.

## 7. Tests

```bash
npm ci
npm run test:bridge      # stub upstream, offline, runs in CI
npm run test:e2e         # needs a real codebuddy --serve (run as wbagent)
npm run test:openai      # official openai SDK against the real path
```

`test:e2e` and `test:openai` need the upstream on `127.0.0.1:8399` and its password
(`~/.codebuddy/settings.json`); as another user they fail with `Authentication required`.

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `409 agent_needs_input` | Ran in a prompting mode. Keep `openai.permissionMode` at `dontAsk` or pass `workbuddy.permissionMode` |
| Empty answer, `finish_reason: "length"` | No agent credential (stuck at `starting…`) or `timeoutSeconds` exceeded. Run `doctor` |
| `401` | Missing, expired or revoked token. Issue a new one with `get-token.mjs` |
| `403 insufficient_scope` | The token lacks `agent:run` |
| `421 invalid_host` | `publicUrl` differs from the URL the client uses |
| Text instead of `tool_calls` | `toolsMode` is not `translate`, or the agent named an undeclared tool |
| `502 Authentication required` | The gateway cannot read the upstream password. Check the service user and `HOME` |
