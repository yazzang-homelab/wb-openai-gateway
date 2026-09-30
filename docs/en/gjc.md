# Appendix: attach to GJC

[Guide](guide.md) · [한국어](../ko/gjc.md) · [Example config](../../examples/gjc-models.yml)

Connect GJC (gajae-code) directly to the gateway's `/v1` as an **OpenAI Chat Completions provider**.
No intermediate proxy: one provider entry in `models.yml` is enough.

```
GJC (your machine: runs tools, keeps the conversation)
  │  POST /v1/chat/completions  (tools + reasoning_effort, stream)
  ▼
wb-agent-gateway  toolsMode=translate  ──▶  CodeBuddy agent (decides the next step)
  │  tool_calls  ◀──────────────────────────────┘
  ▼
GJC runs read/edit/bash locally and sends the result back as role:"tool"
```

The agent only decides *what* to do; GJC executes the tools on your machine.

## 1. Gateway prerequisites

`config.json` needs:

```json
"openai": {
  "toolsMode": "translate",
  "permissionMode": "dontAsk",
  "backendModels": ["gpt-5.5"]
}
```

- `toolsMode: "translate"` — otherwise GJC's tool list is dropped (`ignore`) and the agent answers in text only.
- `permissionMode: "dontAsk"` — GJC cannot send the `workbuddy` extension, so the gateway default applies.
  A prompting mode ends the turn with `409 agent_needs_input`.
- `backendModels` — the backend of every `workbuddy…:<backend>` id you use in GJC must be listed.

## 2. Token

Issue one per device that runs GJC ([guide section 3](guide.md#3-issue-a-token)). Pass it through
the environment; never write it into `models.yml`.

```bash
export WB_AGENT_TOKEN="$(cat ~/.config/wb-agent-token)"
```

For daily use, inject it from an OS secret manager rather than a shell profile.

## 3. Add the provider to `models.yml`

**Merge** the `providers.wb-agent` block from [`examples/gjc-models.yml`](../../examples/gjc-models.yml)
into `~/.gjc/agent/models.yml`. Do not overwrite existing providers.

```yaml
providers:
  wb-agent:
    baseUrl: http://127.0.0.1:8931/v1   # the address GJC actually reaches
    api: openai-completions
    auth: apiKey
    apiKeyEnv: WB_AGENT_TOKEN
    compat:
      supportsReasoningEffort: true
    models:
      - id: workbuddy-minimal:gpt-5.5
        name: WorkBuddy minimal · GPT-5.5
        reasoning: true
        thinking: { minLevel: minimal, maxLevel: xhigh, mode: effort }
        input: [text]
        contextWindow: 200000
        maxTokens: 32000
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
```

- `api: openai-completions` — the gateway serves Chat Completions (`/v1/chat/completions`), not `openai-responses`.
- `compat.supportsReasoningEffort: true` + `thinking` — required for GJC to send a level such as `:high`
  as `reasoning_effort`; the gateway forwards it as the agent's effort.
- `input: [text]` — the gateway replaces image parts with `[image omitted]`.
- Zero `cost` values are placeholders, not a price. Billing follows your CodeBuddy account.
- GJC also lists other ids it finds at `/v1/models`, but with small default limits (for example max output).
  Declare the models you actually use, as above.

## 4. Which model id

| Id | Meaning in GJC |
| --- | --- |
| `workbuddy-minimal:<backend>` | **Recommended.** The agent has no file/MCP tools of its own, so every action surfaces as a GJC tool call |
| `workbuddy:<backend>` | Works, but the agent may run actions allowed under `dontAsk` (such as reads) **on the gateway host** itself |

When the gateway runs on another machine, anything the agent does on the host is unrelated to your
working directory, which makes `minimal` the predictable choice for GJC.

## 5. Selecting it, and a profile

One-off:

```bash
gjc --model "wb-agent/workbuddy-minimal:gpt-5.5:high"
```

To map roles, add a profile to `models.yml`:

```yaml
profiles:
  wb-agent-direct:
    required_providers: [wb-agent]
    display_name: wb-agent-direct
    model_mapping:
      default: wb-agent/workbuddy-minimal:gpt-5.5:medium
      executor: wb-agent/workbuddy-minimal:gpt-5.5:high
      architect: wb-agent/workbuddy-minimal:gpt-5.5:xhigh
      planner: wb-agent/workbuddy-minimal:gpt-5.5:xhigh
      critic: wb-agent/workbuddy-minimal:gpt-5.5:high
```

```bash
gjc --mpreset wb-agent-direct
```

## 6. Verification

You can check everything in a throwaway agent directory before touching your real config.

```bash
mkdir -p /tmp/gjc-wb && cp examples/gjc-models.yml /tmp/gjc-wb/models.yml   # edit baseUrl
export GJC_CODING_AGENT_DIR=/tmp/gjc-wb WB_AGENT_TOKEN="$(cat ~/.config/wb-agent-token)"

gjc --list-models workbuddy-minimal                                   # 1) model is known
gjc -p --no-tools --model "wb-agent/workbuddy-minimal:gpt-5.5" "Reply with exactly: OK"   # 2) text
echo "secret-word: pineapple-42" > note.txt
gjc -p --tools=read --model "wb-agent/workbuddy-minimal:gpt-5.5:high" \
  "Use the read tool to read ./note.txt and reply with only the secret word."          # 3) tool call
```

If step 3 answers `pineapple-42`, GJC's `read` tool was invoked through `tool_calls`; the session file
(`$GJC_CODING_AGENT_DIR/sessions/…jsonl`) records `"type":"toolCall","name":"read"`. Then
`unset GJC_CODING_AGENT_DIR` and merge into your real `models.yml`.

All three steps passed with GJC 0.18.1 while writing this repo (text ≈15 s, one tool round ≈30 s).

## 7. Limits to know

- **Streaming arrives at the end.** `translate` can only classify a reply once complete, so there is no
  token-by-token output; a keepalive every 15 s keeps the connection open.
- **300 s per turn.** GJC cannot send `workbuddy.timeoutSeconds`, so the default applies; beyond it the
  partial answer comes back with `finish_reason: "length"`.
- **Latency.** Every turn creates and stops one agent job; tool-heavy tasks accumulate delay.
- **Usage is an estimate** (character based), so GJC's usage/cost display is indicative only.
- `max_tokens` and `temperature` are ignored.

## 8. Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| `Model "wb-agent/…" not found` | `models.yml` location (or `GJC_CODING_AGENT_DIR`), provider name, `id` spelling |
| `custom models need a credential source` | `apiKeyEnv` is missing |
| `401` | `WB_AGENT_TOKEN` empty, expired or revoked; make sure it is exported in the shell that runs GJC |
| `409 agent_needs_input` | The gateway's `openai.permissionMode` prompts; set `dontAsk` |
| Answers in prose instead of using tools | Gateway `toolsMode` is not `translate` (response header `X-WorkBuddy-Tools-Ignored: 1`) |
| `:high` has no effect | `compat.supportsReasoningEffort: true` or `thinking` is missing |
| Odd answers that look like server-side files | Use `workbuddy-minimal` instead of `workbuddy` (cli) |
