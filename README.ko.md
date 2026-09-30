# wb-openai-gateway

WorkBuddy / CodeBuddy 에이전트 앞에 OAuth로 보호되는 **OpenAI 호환 API(`/v1`)** 를 세우는 게이트웨이입니다.
OpenAI SDK, `curl`, GJC가 `base_url`과 토큰만으로 붙고, 함수 호출은 진짜 `tool_calls`로 돌아옵니다.

- [가이드](docs/ko/guide.md) — 인증 3계층, 설치(Linux/systemd), 설정, 토큰 발급, 권한 모드와 `409 agent_needs_input`, 함수 호출, 테스트, 문제 해결
- [별첨: GJC에 붙이기](docs/ko/gjc.md) — `models.yml` 공급자, 모델 선택, 프로필, 격리 검증, 제약
- [예시 설정](examples/gjc-models.yml) · [systemd 유닛](deploy/wb-agent-gateway.service) · [토큰 발급 스크립트](tools/get-token.mjs)
- English: [README.md](README.md) · [guide](docs/en/guide.md) · [GJC appendix](docs/en/gjc.md)

```bash
npm ci
npm run test:bridge   # 스텁 업스트림, 오프라인
npm run test:site     # 가이드 사이트 빌드 + 링크 검사
```

게이트웨이 코드에는 MCP 엔드포인트(`/mcp`)도 그대로 들어 있지만, 이 저장소의 문서는 OpenAI API 경로만 다룹니다.
