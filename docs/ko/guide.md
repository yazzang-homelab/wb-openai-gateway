# wb-openai-gateway 가이드

[README](../../README.ko.md) · [English](../en/guide.md) · [별첨: GJC 연결](gjc.md)

WorkBuddy / CodeBuddy 에이전트를 **OpenAI 호환 API(`/v1`)** 로 쓰기 위한 게이트웨이입니다.
OpenAI SDK, `curl`, GJC처럼 `base_url` + `api_key`만 받는 클라이언트가 그대로 붙습니다.

```
OpenAI 클라이언트 ──Bearer──▶ wb-agent-gateway (/v1) ──비밀번호──▶ codebuddy --serve ──▶ 모델 백엔드
 (SDK · curl · GJC)            127.0.0.1:8931                     127.0.0.1:8399
```

게이트웨이에는 MCP 엔드포인트(`/mcp`)도 들어 있지만 이 가이드는 OpenAI API 경로만 다룹니다.

## 왜 쓰나요

WorkBuddy / CodeBuddy 계정이 있으면 그 계정으로 쓸 수 있는 모델(GPT-5.5 등)과 코딩 에이전트가 생깁니다.
하지만 그 에이전트는 WorkBuddy 앱이나 `codebuddy` CLI 안에서만 쓸 수 있습니다.
`codebuddy --serve`의 HTTP API는 공유 비밀번호와 브라우저 쿠키로만 보호되고 OpenAI 형식도 아니어서,
다른 도구가 붙을 방법이 없습니다.

이 게이트웨이는 그 사이를 메웁니다.

- **이미 가진 계정을 다른 도구에서.** OpenAI SDK, `curl`, GJC처럼 `base_url` + `api_key`만 받는 클라이언트가 코드 수정 없이 붙습니다.
- **클라이언트별 토큰.** 공유 비밀번호를 나눠 주는 대신, 기기마다 범위가 정해지고 따로 폐기할 수 있는 OAuth 토큰을 발급합니다.
- **클라이언트 쪽 도구 루프.** `translate` 모드에서 에이전트의 판단을 진짜 `tool_calls`로 돌려주므로, GJC 같은 클라이언트가 자기 컴퓨터에서 도구를 실행할 수 있습니다.
- **멈추지 않는 기본값.** OpenAI 요청은 권한 질문에 답할 수 없어서 기본 권한 모드를 `dontAsk`로 둡니다.
- **상주 운영.** `codebuddy --serve`를 직접 띄우고 감시·재시작합니다.

**비공식 연동입니다.** WorkBuddy/CodeBuddy가 이런 사용을 허용·지원한다고 보장하지 않습니다.
자동화, 다른 도구·사람에게 계정 제공, 재판매, 사용량 제한 우회가 내 계정의 약관에서 허용되는지 먼저 확인하세요.
계정 제한·추가 과금·기능 변경 위험은 사용자가 집니다. 프롬프트뿐 아니라 도구 결과에 담긴 소스와 데이터도
게이트웨이 → 에이전트 → 모델 공급자로 전달됩니다.

**안 맞는 경우.** 모델 공급자 API 키가 이미 있으면 공급자에 직접 연결하세요. 턴마다 에이전트 작업을 하나씩 만들고 끝내는 구조라 더 느리고,
`translate` 모드에서는 스트리밍이 답이 끝난 뒤 한꺼번에 오며, 토큰 사용량도 추정치입니다.

## 1. 인증은 세 겹입니다

| 계층 | 무엇을 보호하나 | 어디에 있나 |
| --- | --- | --- |
| OAuth 액세스 토큰 | 클라이언트 → 게이트웨이 | 동의 절차로 발급 (`tools/get-token.mjs`) |
| 게이트웨이 비밀번호 | 게이트웨이 → `codebuddy --serve` | `~/.codebuddy/settings.json`의 `gateway.password` (자동) |
| 에이전트 자격증명 | 에이전트 → 모델 백엔드 | `CODEBUDDY_API_KEY` 또는 `CODEBUDDY_AUTH_TOKEN` |

**무료 계정도 됩니다.** API 키(`CODEBUDDY_API_KEY`)는 Pro 사용자만 발급받을 수 있지만, 무료 계정은 CLI 로그인 세션으로 씁니다
(아래 "무료 계정: CLI 로그인" 참고). 2026-09-30 무료 계정으로 `gpt-5.5`, `gpt-6-astra`, `glm-5.3`, `kimi-k3` 등의 응답과
게이트웨이 경유 텍스트·`tool_calls`를 확인했습니다. 사용량 한도는 계정 등급에 따릅니다.

세 번째가 없으면 작업이 `starting…`에 멈추고 결국 빈 응답(`finish_reason: "length"`)이 돌아옵니다.
`CODEBUDDY_API_KEY`는 계정 지역에 맞는 `CODEBUDDY_INTERNET_ENVIRONMENT`가 필요합니다
(국제판은 비워 두고, 중국판은 `internal`).

## 2. 설치 (Linux)

게이트웨이 실행에는 Node.js 18.17 이상이 필요하고 런타임 의존성이 없습니다.
가이드 사이트 빌드(`npm run test:site`, `marked` 사용)는 Node.js 20 이상이 필요합니다.

전용 사용자로 돌리는 것을 권장합니다. 에이전트의 파일/셸 도구가 그 사용자 권한으로 실행되기 때문입니다.

```bash
useradd -m -s /bin/bash wbagent
runuser -u wbagent -- bash -lc '
  mkdir -p ~/.local ~/wb-agent-work
  npm install --prefix ~/.local/codebuddy @tencent-ai/codebuddy-code
  git clone <이 레포> ~/.local/wb-agent-gateway
'
```

### 자격증명 파일

`/home/wbagent/.local/wb-agent-gateway/.env` (권한 `600`, 커밋 금지. 저장소 `.gitignore`가 `.env`를 제외하지만, 이미 커밋된 비밀은 지워지지 않습니다):

```ini
CODEBUDDY_API_KEY=발급받은-키
# CODEBUDDY_INTERNET_ENVIRONMENT=internal   # 중국판일 때만
WB_AGENT_GATEWAY_ACCESS_CODE=openssl-rand-base64-24-로-만든-값
```

`WB_AGENT_GATEWAY_ACCESS_CODE`는 새 클라이언트를 승인할 때 쓰는 암호입니다. 없으면 동의 화면이 꺼져서
어떤 클라이언트도 새로 승인할 수 없습니다.

### 무료 계정: CLI 로그인

API 키 대신, 서비스 사용자로 CLI를 한 번 대화형으로 실행해 로그인합니다. 세션은 `~/.codebuddy`에 저장되고
게이트웨이가 띄우는 `codebuddy --serve`가 그대로 씁니다. 이 경우 `.env`에는 `WB_AGENT_GATEWAY_ACCESS_CODE`만 둡니다.

```bash
runuser -u wbagent -- bash -lc 'cd ~/wb-agent-work && ~/.local/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'
# 폴더 신뢰 → "Log in via International Site"(중국판은 Chinese Site) → 출력된 URL을 브라우저에서 열어 로그인
```

**작업 폴더를 반드시 신뢰 목록에 넣으세요.** 백그라운드 작업은 폴더 신뢰 질문을 화면 없이 기다리며 `preparing`에 멈추고,
게이트웨이는 결국 빈 답(`finish_reason: "length"`)을 돌려줍니다. 대화형 창에서 신뢰를 골라도 저장되지 않을 수 있으니
`~/.codebuddy/settings.json`에 직접 적습니다.

```json
{ "trustedDirectories": ["/home/wbagent/wb-agent-work"] }
```

### 설정 파일

`/home/wbagent/.wb-agent-gateway/config.json`:

```json
{
  "host": "127.0.0.1",
  "port": 8931,
  "publicUrl": "http://127.0.0.1:8931",
  "accessTokenTtl": 86400,
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

- `upstream.autoStart: true` — 게이트웨이가 `codebuddy --serve`를 직접 띄우고 감시·재시작합니다.
  이때 `.env`의 자격증명이 자식 프로세스로 전달됩니다.
- `openai.backendModels` — 여기 적은 백엔드마다 `workbuddy:<백엔드>` 같은 모델 ID가 `/v1/models`에 나타납니다.
  계정에서 실제로 쓸 수 있는 모델 이름만 넣으세요.
- `accessTokenTtl` — 액세스 토큰 수명(초). 기본은 3600(1시간)이고 예시는 86400(1일)입니다.
  유출된 토큰은 만료 전까지 쓸 수 있으니 길게 잡지 마세요. 만료되면 3절로 다시 발급합니다.
- `openai.toolsMode`, `openai.permissionMode` — 5, 6절에서 설명합니다.

### 서비스 등록

`deploy/wb-agent-gateway.service`를 경로에 맞게 고쳐 등록합니다. 내장 `install-service` 명령은 macOS(launchd) 전용입니다.

```bash
cp deploy/wb-agent-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wb-agent-gateway
journalctl -u wb-agent-gateway -n 20 --no-pager
```

정상이면 로그에 `OpenAI base URL`, `OpenAI permissions  dontAsk`, `upstream ready`가 보입니다.
`node bin/wb-agent-gateway.js doctor`(wbagent 사용자로 실행)는 자격증명과 업스트림 상태를 점검합니다.

### 네트워크 노출

`host`를 루프백이 아닌 주소로 바꾸면 **명령 실행 엔드포인트가 그 네트워크에 열립니다**(시작 로그에 경고가 뜹니다).
Tailscale 같은 사설망 주소에만 두고, 공인 인터넷에 열지 마세요. HTTPS는 암호화일 뿐 접근 통제가 아닙니다.
외부에서 접근해야 하면 TLS에 더해 VPN, 방화벽 허용 목록, 인증 프록시 중 하나로 접근 자체를 막으세요.
클라이언트 등록(`/register`)은 인증 없이 열려 있고, 승인 암호 시도 제한은 클라이언트별이라 전역 무차별 대입 방어가 아닙니다.
인증 없이 열리는 `/health`는 CodeBuddy 계정 이름, 로그인 여부, 등록 클라이언트 수를 돌려줍니다. 이 점도 노출 범위를 정할 때 고려하세요.
`publicUrl`은 클라이언트가 실제로 접속하는 주소와 같아야 합니다. 다르면 `421 invalid_host`가 납니다.

## 3. 토큰 발급

브라우저 없는 클라이언트용으로 `tools/get-token.mjs`가 동적 등록 → PKCE 승인 → 토큰 교환을 한 번에 합니다.
토큰은 stdout으로만 나오므로 파일로 바로 받으세요.

```bash
umask 077; mkdir -p ~/.config
runuser -u wbagent -- bash -c 'set -a; . ~/.local/wb-agent-gateway/.env; set +a
  node ~/.local/wb-agent-gateway/tools/get-token.mjs --url http://127.0.0.1:8931 --name my-laptop' \
  > ~/.config/wb-agent-token.new && mv ~/.config/wb-agent-token.new ~/.config/wb-agent-token
```

- 승인 암호는 `WB_AGENT_GATEWAY_ACCESS_CODE` 환경변수 또는 설정 파일의 `accessCode`에서 읽습니다. 도구는 `.env`를 직접 읽지 않으므로 위처럼 불러옵니다.
- `umask 077`을 먼저 해야 토큰 파일이 처음부터 본인만 읽을 수 있게 만들어집니다. 발급에 실패하면 기존 토큰 파일은 그대로 남습니다.
- 루프백이 아닌 `http://` 주소로는 승인 암호를 보내지 않습니다. 이미 암호화된 VPN(예: Tailscale) 위라면 `--allow-insecure-http`를 붙입니다.
- 기기(클라이언트)마다 따로 발급하세요. `clients`로 목록을 보고 `rm-client <id>`로 등록을 지웁니다.
  **`rm-client`는 서비스를 멈춘 상태에서 실행하세요.** 실행 중인 게이트웨이는 메모리 상태를 `state.json`에 다시 써서 삭제를 되돌립니다.
  등록을 지워도 이미 발급된 토큰은 만료 전까지 유효합니다. 기기를 잃어버렸다면 그 토큰을 직접 폐기하세요:
  `curl -X POST http://127.0.0.1:8931/revoke -d "token=$(cat ~/.config/wb-agent-token)"`

## 4. 호출해 보기

```bash
TOKEN=$(cat ~/.config/wb-agent-token)
curl -s http://127.0.0.1:8931/v1/models -H "Authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:8931/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"workbuddy:gpt-5.5","messages":[{"role":"user","content":"OK라고만 답해"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8931/v1", api_key=TOKEN)
client.chat.completions.create(model="workbuddy:gpt-5.5",
                               messages=[{"role": "user", "content": "OK라고만 답해"}])
```

### 모델 ID

| 모델 ID | 에이전트 모드 | 설명 |
| --- | --- | --- |
| `workbuddy` | `cli` | 기본. 에이전트 자신의 도구(읽기·쓰기·bash·MCP·스킬)를 가짐 |
| `workbuddy-ptc` | `ptc` | 여러 단계를 스크립트 하나로 묶어 실행 |
| `workbuddy-minimal` | `minimal` | 샌드박스 REPL만. 파일/MCP 도구 없음 |

뒤에 `:<백엔드>`를 붙이면 그 백엔드 모델로 실행합니다(`backendModels`에 있어야 함).
**모르는 ID는 오류 없이 기본 `cli` 에이전트(전체 도구)로 실행**되고 요청한 ID가 그대로 응답에 들어갑니다.
`backendModels`에 없는 백엔드를 붙인 `workbuddy-minimal:…`도 마찬가지로 `cli`가 되니, 쓰는 백엔드는 반드시 등록하세요.

### 표준 필드 처리

- `stream: true` 지원. 오래 걸리는 작업 동안 15초마다 SSE keepalive를 보냅니다.
- `reasoning_effort`는 에이전트의 effort(`minimal`~`max`)로 전달됩니다.
- `temperature`, `top_p`, `max_tokens`, `stop`은 검사 없이 무시합니다. 이미지 입력은 `[image omitted]`로 바뀝니다.
- `usage`는 글자 수로 추정한 값입니다.

### 확장 필드 `workbuddy`

```json
{ "workbuddy": { "cwd": "/repo", "permissionMode": "acceptEdits", "effort": "high",
                 "name": "nightly", "timeoutSeconds": 600 } }
```

`timeoutSeconds`(기본 300, 최대 1800)가 지나면 그때까지의 부분 답을 `finish_reason: "length"`로 돌려주고 작업을 멈춥니다.

## 5. 권한 모드 (`409 agent_needs_input`)

에이전트가 자기 도구를 쓰기 전에 권한 확인을 기다리면(`blocked`), OpenAI 요청은 그 질문에 답할 방법이 없습니다.
게이트웨이는 작업을 멈추고, 그때까지 나온 답이 없으면 `409 agent_needs_input`을 돌려줍니다.
스트리밍 요청은 이미 HTTP 200을 보낸 뒤라서, 같은 오류가 스트림 안의 `error` 필드가 있는 청크로 옵니다.

그래서 `workbuddy.permissionMode`를 주지 않은 요청은 게이트웨이 설정 `openai.permissionMode`(기본 `dontAsk`)로 실행됩니다.

| 모드 | 동작 |
| --- | --- |
| `dontAsk` (기본) | 묻지 않음. 미리 허용됐거나 안전한 동작만 실행하고, 승인이 필요한 동작은 거부 |
| `acceptEdits` | 파일 수정은 자동 허용, 그 외 승인이 필요한 동작은 확인을 기다림 |
| `bypassPermissions` | 모든 동작 허용. 게이트웨이에 접근 가능한 사람은 누구나 서버에서 명령을 실행할 수 있게 됨 |
| `plan` | 분석만 하고 파일 수정·명령 실행은 하지 않음 |
| `default` | 도구마다 처음 쓸 때 권한을 물음. OpenAI 경로에서는 409로 끝남 |
| `auto` | AI 분류기가 동작을 검토해 안전한 것만 실행. 확인이 필요하면 409가 날 수 있음 |

바꾸는 방법(우선순위 순서): 요청의 `workbuddy.permissionMode` → `--permission-mode` →
`WB_AGENT_GATEWAY_PERMISSION_MODE` → 설정 파일 `openai.permissionMode`.
설정 값이 잘못되면 게이트웨이가 시작하지 않고, 요청 값이 잘못되면 그 요청만 `400`입니다.

> **`dontAsk`는 기본값이지 상한이 아닙니다.** `agent:run` 토큰을 가진 사람은 요청에서
> `permissionMode: "bypassPermissions"`와 임의의 `cwd`를 지정할 수 있고, 에이전트는 서비스 사용자 권한으로 돕니다.
> `agent:run` 토큰은 그 서버 사용자 계정을 넘겨주는 것과 같다고 보고, 믿는 사람·기기에만 발급하세요.
> 서비스 유닛의 `WorkingDirectory`와 `NoNewPrivileges`는 파일 접근 제한이 아닙니다. 에이전트는 게이트웨이의 환경변수
> (`.env`의 API 키, 승인 암호 포함)도 물려받습니다. 더 강한 격리가 필요하면 전용 VM이나 컨테이너에서 돌리세요.

## 6. 함수 호출 (`openai.toolsMode`)

에이전트는 도구를 직접 실행하는 자율 에이전트라서, 원래는 "이 도구를 호출해 달라"는 응답(`tool_calls`)을 돌려줄 수 없습니다.
`toolsMode`가 이 차이를 처리합니다.

| 모드 | 동작 |
| --- | --- |
| `ignore` (기본) | `tools`를 버리고 텍스트로 답함. 응답 헤더 `X-WorkBuddy-Tools-Ignored: 1` |
| `reject` | `tools`가 있으면 `400 tools_not_supported` |
| `translate` | 선언된 도구 스키마를 프롬프트에 넣고, 에이전트가 낸 호출 봉투를 진짜 `tool_calls`로 바꿔 돌려줌 |

GJC처럼 도구 루프를 클라이언트가 돌리는 경우에는 `translate`가 필요합니다.

- 선언된 이름과 일치할 때만 도구 호출로 인정합니다. 답변 속 예시 JSON은 텍스트로 남습니다.
- `translate`에서는 답이 끝나야 텍스트인지 도구 호출인지 알 수 있어서, 스트리밍이 끝에 한 번에 나옵니다.
- `tool_choice`의 `required`나 특정 함수 지정은 프롬프트로 전달하는 지시라 강제되지는 않습니다.

## 7. 테스트

```bash
npm ci
npm run test:bridge      # 스텁 업스트림. 오프라인, CI에서 실행
npm run test:e2e         # 실제 codebuddy --serve 필요 (wbagent 사용자로 실행)
npm run test:openai      # 공식 openai SDK로 실제 경로 검사
```

`test:e2e`와 `test:openai`는 `127.0.0.1:8399`의 업스트림과 그 비밀번호(`~/.codebuddy/settings.json`)가 필요합니다.
다른 사용자로 돌리면 `Authentication required`로 실패합니다.

## 8. 문제 해결

| 증상 | 원인 / 조치 |
| --- | --- |
| `409 agent_needs_input` (스트림에서는 `error` 청크) | 권한을 묻는 모드로 실행됨. `openai.permissionMode`를 `dontAsk`로 두거나 요청에 `workbuddy.permissionMode`를 지정 |
| 빈 답, `finish_reason: "length"` | 에이전트 자격증명 없음(`starting…`에 멈춤), 작업 폴더가 `trustedDirectories`에 없음(`preparing`에 멈춤), 또는 `timeoutSeconds` 초과. `doctor`로 확인 |
| `401` | 토큰 없음·만료·폐기. `get-token.mjs`로 다시 발급 |
| `403 insufficient_scope` | 토큰에 `agent:run` 범위가 없음 |
| `421 invalid_host` | `publicUrl`이 클라이언트 접속 주소와 다름 |
| `tool_calls` 대신 텍스트 | `toolsMode`가 `translate`가 아님, 또는 에이전트가 선언되지 않은 도구 이름을 냄 |
| `502 Authentication required` | 게이트웨이가 업스트림 비밀번호를 못 읽음. 서비스 사용자와 `HOME`이 맞는지 확인 |
