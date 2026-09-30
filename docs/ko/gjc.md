# 별첨: GJC에 붙이기

[가이드](guide.md) · [English](../en/gjc.md) · [예시 설정](../../examples/gjc-models.yml)

GJC(gajae-code)를 게이트웨이의 `/v1`에 **OpenAI Chat Completions 공급자**로 직접 연결합니다.
중간 프록시 없이 `models.yml`에 공급자 하나만 추가하면 됩니다.

```
GJC (내 컴퓨터: 도구 실행, 대화 기록)
  │  POST /v1/chat/completions  (tools + reasoning_effort, stream)
  ▼
wb-agent-gateway  toolsMode=translate  ──▶  CodeBuddy 에이전트 (다음 행동 결정)
  │  tool_calls  ◀──────────────────────────────┘
  ▼
GJC가 read/edit/bash 등을 로컬에서 실행하고 결과를 role:"tool"로 다시 보냄
```

에이전트는 "무엇을 할지"만 정하고, 실제 도구 실행은 GJC가 내 컴퓨터에서 합니다.

## 1. 게이트웨이 쪽 전제

`config.json`에 아래가 있어야 합니다.

```json
"openai": {
  "toolsMode": "translate",
  "permissionMode": "dontAsk",
  "backendModels": ["gpt-5.5"]
}
```

- `toolsMode: "translate"` — 없으면 GJC가 보낸 도구 목록이 무시되고(`ignore`) 에이전트가 텍스트로만 답합니다.
- `permissionMode: "dontAsk"` — GJC는 `workbuddy` 확장 필드를 보낼 수 없어서 게이트웨이 기본값이 그대로 적용됩니다.
  권한을 묻는 모드면 `409 agent_needs_input`으로 턴이 끝납니다.
- `backendModels` — GJC에서 쓸 `workbuddy…:<백엔드>` ID의 백엔드가 여기 있어야 합니다.

## 2. 토큰

GJC를 쓰는 기기마다 따로 발급합니다([가이드 3절](guide.md#3-토큰-발급)).
토큰은 `models.yml`에 적지 말고 환경변수로 넘깁니다.

```bash
export WB_AGENT_TOKEN="$(cat ~/.config/wb-agent-token)"
```

반복해서 쓸 때는 셸 프로필보다 OS 비밀 관리자로 주입하는 편이 안전합니다.

## 3. `models.yml`에 공급자 추가

[`examples/gjc-models.yml`](../../examples/gjc-models.yml)의 `providers.wb-agent` 블록을 `~/.gjc/agent/models.yml`에 **병합**합니다.
기존 공급자를 덮어쓰지 마세요.

```yaml
providers:
  wb-agent:
    baseUrl: http://127.0.0.1:8931/v1   # GJC가 실제로 접속하는 주소
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

- `api: openai-completions` — 게이트웨이는 Chat Completions(`/v1/chat/completions`)를 제공합니다. `openai-responses`가 아닙니다.
- `compat.supportsReasoningEffort: true` + `thinking` — 이게 있어야 GJC가 `:high` 같은 강도를 `reasoning_effort`로 보냅니다.
  게이트웨이는 이 값을 에이전트 effort로 넘깁니다.
- `input: [text]` — 게이트웨이는 이미지 입력을 `[image omitted]`로 바꿉니다.
- `cost`의 0은 자리표시일 뿐 무료라는 뜻이 아닙니다. 실제 과금은 CodeBuddy 계정 기준입니다.
- GJC는 `/v1/models`의 다른 ID도 자동으로 목록에 보여 주지만, 이때 출력 한도 같은 값은 작은 기본값으로 잡힙니다.
  실제로 쓸 모델은 위처럼 명시하세요.

## 4. 어떤 모델 ID를 쓸까

| ID | GJC에서의 의미 |
| --- | --- |
| `workbuddy-minimal:<백엔드>` | **권장.** 에이전트 쪽 파일/MCP 도구가 없어서 행동이 GJC 도구 호출로만 나옵니다 |
| `workbuddy:<백엔드>` | 동작은 합니다. 다만 에이전트가 `dontAsk`에서 허용되는 안전한 동작(예: 읽기)을 **게이트웨이 서버에서** 직접 실행할 수 있습니다 |

게이트웨이가 다른 컴퓨터에 있으면, 에이전트가 서버에서 직접 실행한 결과는 내 작업 디렉터리와 무관합니다.
그래서 GJC에서는 `minimal`이 더 예측 가능합니다.

## 5. 선택과 프로필

한 번만 쓸 때:

```bash
gjc --model "wb-agent/workbuddy-minimal:gpt-5.5:high"
```

역할별로 묶어 두려면 `models.yml`에 프로필을 추가합니다.

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

## 6. 검증 순서

실제 설정을 건드리기 전에 임시 에이전트 디렉터리로 먼저 확인할 수 있습니다.

```bash
mkdir -p /tmp/gjc-wb && cp examples/gjc-models.yml /tmp/gjc-wb/models.yml   # baseUrl 수정
export GJC_CODING_AGENT_DIR=/tmp/gjc-wb WB_AGENT_TOKEN="$(cat ~/.config/wb-agent-token)"

gjc --list-models workbuddy-minimal                                   # 1) 모델 인식
gjc -p --no-tools --model "wb-agent/workbuddy-minimal:gpt-5.5" "Reply with exactly: OK"   # 2) 텍스트
echo "secret-word: pineapple-42" > note.txt
gjc -p --tools=read --model "wb-agent/workbuddy-minimal:gpt-5.5:high" \
  "Use the read tool to read ./note.txt and reply with only the secret word."          # 3) 도구 호출
```

세 번째가 `pineapple-42`를 답하면 GJC의 `read` 도구가 `tool_calls`로 불린 것입니다.
세션 파일(`$GJC_CODING_AGENT_DIR/sessions/…jsonl`)에 `"type":"toolCall","name":"read"`가 남습니다.
확인이 끝나면 `unset GJC_CODING_AGENT_DIR` 하고 실제 `models.yml`에 병합하세요.

이 저장소 작성 시 GJC 0.18.1로 위 세 단계를 모두 통과했습니다(텍스트 약 15초, 도구 호출 1회 약 30초).

## 7. 알아둘 제약

- **스트리밍이 끝에 몰려 옵니다.** `translate`는 답이 끝나야 텍스트인지 도구 호출인지 판단하므로 토큰 단위로 흘러나오지 않습니다.
  대신 15초마다 keepalive를 보내 연결은 유지됩니다.
- **턴마다 시간 제한 300초.** GJC는 `workbuddy.timeoutSeconds`를 보낼 수 없어 기본값이 적용됩니다.
  넘으면 부분 답이 `finish_reason: "length"`로 옵니다.
- **느립니다.** 한 턴마다 에이전트 작업 하나가 생성·종료됩니다. 도구 호출이 많은 작업일수록 누적 지연이 큽니다.
- **토큰 사용량은 추정치**(글자 수 기준)라 GJC의 사용량·비용 표시는 참고용입니다.
- `max_tokens`, `temperature`는 무시됩니다.

## 8. 문제 해결

| 증상 | 확인 / 조치 |
| --- | --- |
| `Model "wb-agent/…" not found` | `models.yml` 위치(또는 `GJC_CODING_AGENT_DIR`)와 공급자 이름, `id` 철자 |
| `custom models need a credential source` | `apiKeyEnv`가 빠짐 |
| `401` | `WB_AGENT_TOKEN`이 비었거나 만료/폐기됨. GJC를 실행한 셸에서 export 됐는지 확인 |
| `409 agent_needs_input` | 게이트웨이 `openai.permissionMode`가 권한을 묻는 모드임. `dontAsk`로 |
| 도구를 안 쓰고 말로만 답함 | 게이트웨이 `toolsMode`가 `translate`가 아님(응답 헤더 `X-WorkBuddy-Tools-Ignored: 1`) |
| `:high`가 먹지 않음 | `compat.supportsReasoningEffort: true`와 `thinking` 누락 |
| 서버 쪽 파일을 읽은 듯한 엉뚱한 답 | `workbuddy`(cli) 대신 `workbuddy-minimal` 사용 |
