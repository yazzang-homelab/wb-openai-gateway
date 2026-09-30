# wb-openai-gateway

WorkBuddy / CodeBuddy 에이전트 앞에 OAuth로 보호되는 **OpenAI 호환 API(`/v1`)** 를 세우는 게이트웨이입니다.
OpenAI SDK, `curl`, GJC가 `base_url`과 토큰만으로 붙고, 함수 호출은 진짜 `tool_calls`로 돌아옵니다.

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

**안 맞는 경우.** 모델 공급자 API 키가 이미 있으면 공급자에 직접 연결하세요. 턴마다 에이전트 작업을 하나씩 만들고 끝내는 구조라 더 느리고,
`translate` 모드에서는 스트리밍이 답이 끝난 뒤 한꺼번에 오며, 토큰 사용량도 추정치입니다.

## 문서

- [가이드](docs/ko/guide.md) — 인증 3계층, 설치(Linux/systemd), 설정, 토큰 발급, 권한 모드와 `409 agent_needs_input`, 함수 호출, 테스트, 문제 해결
- [별첨: GJC에 붙이기](docs/ko/gjc.md) — `models.yml` 공급자, 모델 선택, 프로필, 격리 검증, 제약
- [예시 설정](examples/gjc-models.yml) · [systemd 유닛](deploy/wb-agent-gateway.service) · [토큰 발급 스크립트](tools/get-token.mjs)
- English: [README.md](README.md) · [guide](docs/en/guide.md) · [GJC appendix](docs/en/gjc.md)

```bash
npm ci
npm run test:bridge   # 스텁 업스트림, 오프라인
npm run test:site     # 가이드 사이트 빌드 + 링크 검사
```

원본: 원작자 허락을 받아 [dbc-hbin/wb-agent-gateway](https://github.com/dbc-hbin/wb-agent-gateway)를 수정했습니다. [NOTICE.md](NOTICE.md) 참고.

게이트웨이 코드에는 MCP 엔드포인트(`/mcp`)도 그대로 들어 있지만, 이 저장소의 문서는 OpenAI API 경로만 다룹니다.
