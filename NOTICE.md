# NOTICE / 출처와 허락

## English

The gateway source in this repository (`bin/`, `src/`, `test/`, `tools/mock-model.mjs`, `docs/*-preview.*`
and most of `README.md`) is derived from **[dbc-hbin/wb-agent-gateway](https://github.com/dbc-hbin/wb-agent-gateway)**,
commit `9fcb64f0922f3225601378830c3745d29b88bc1f`, by dbc-hbin.

The upstream repository carries no license file. This repository modifies and republishes that code
**with the author's permission**, granted to the maintainer (yazzang-homelab) directly by the author over Discord
on 2026-09-30. That permission is not a general open-source license: if you want to reuse the upstream code
beyond this repository, ask the author yourself.

Changes to upstream code:

- `openai.backendModels`: exposes `<pseudo-model>:<backend>` model ids (e.g. `workbuddy:gpt-5.5`) in `/v1/models`
  and dispatches with that backend model (`src/openai.js`, `src/config.js`).
- `openai.permissionMode` (default `dontAsk`) for OpenAI jobs that omit `workbuddy.permissionMode`, with
  `--permission-mode` / `WB_AGENT_GATEWAY_PERMISSION_MODE` and start-time validation (`src/config.js`,
  `src/openai.js`, `bin/wb-agent-gateway.js`); the `409 agent_needs_input` message mentions it.
- The `doctor` text for a missing access code no longer claims consent auto-approves.
- `config.example.json`: `accessCode` is `null` instead of `CHANGE-ME`; documents `permissionMode`.
- `test/tool-bridge.mjs`: checks for the two settings above. `.gitignore`, `package.json` scripts and dev dependency.

Added here: `tools/get-token.mjs`, `deploy/`, `docs/ko/`, `docs/en/`, `examples/`, `site/`, `scripts/build-site.mjs`,
`test/site.mjs`, `.github/workflows/`, `README.ko.md`, `NOTICE.md`, the top of `README.md` and its
permission-mode rows.

Not affiliated with or endorsed by Tencent, WorkBuddy or CodeBuddy.

## 한국어

이 저장소의 게이트웨이 소스(`bin/`, `src/`, `test/`, `tools/mock-model.mjs`, `docs/*-preview.*`, `README.md` 대부분)는
dbc-hbin의 **[dbc-hbin/wb-agent-gateway](https://github.com/dbc-hbin/wb-agent-gateway)** 커밋
`9fcb64f0922f3225601378830c3745d29b88bc1f`에서 가져왔습니다.

원본 저장소에는 라이선스 파일이 없습니다. 이 저장소는 2026-09-30 원작자가 Discord로 관리자(yazzang-homelab)에게 직접 준
**허락을 받아** 해당 코드를 수정해 다시 공개합니다. 이 허락은 일반적인 오픈소스 라이선스가 아니므로,
이 저장소 밖에서 원본 코드를 다시 쓰려면 원작자에게 직접 허락을 받으세요.

원본 코드에서 바꾼 것:

- `openai.backendModels`: `<가상 모델>:<백엔드>` ID(예: `workbuddy:gpt-5.5`)를 `/v1/models`에 노출하고 그 백엔드로 실행
- `openai.permissionMode`(기본 `dontAsk`): `workbuddy.permissionMode`가 없는 OpenAI 작업의 권한 모드. `--permission-mode`,
  `WB_AGENT_GATEWAY_PERMISSION_MODE`, 시작 시 검증, `409 agent_needs_input` 안내 문구
- 승인 암호가 없을 때 `doctor`가 "자동 승인"이라고 잘못 표시하던 문구 수정
- `config.example.json`: `accessCode`를 `CHANGE-ME` 대신 `null`로, `permissionMode` 설명 추가
- `test/tool-bridge.mjs`에 위 두 설정 검사 추가, `.gitignore`·`package.json` 스크립트와 개발 의존성

새로 추가한 것: `tools/get-token.mjs`, `deploy/`, `docs/ko/`, `docs/en/`, `examples/`, `site/`, `scripts/build-site.mjs`,
`test/site.mjs`, `.github/workflows/`, `README.ko.md`, `NOTICE.md`, `README.md` 상단과 권한 모드 관련 행

Tencent, WorkBuddy, CodeBuddy와 관계없는 비공식 프로젝트입니다.
