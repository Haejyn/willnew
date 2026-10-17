# 허브와 러너 설계

상태: 설계만. 구현 전 (2026-10-14)

## 목표

지금 willnew 는 한 프로세스가 채널, 실행, 검토, 반영을 다 하고, 에이전트는 서버를 띄운 사람의 Claude, Codex 로그인으로 돈다. 팀원이 맡긴 일을 한 사람의 구독으로 처리하면 이용 조건에 맞지 않는다.

나눈 뒤 모습은 이렇다.

- 허브 하나: 채널, 요청 기록, 검토, 반영, 지표. AI 자격증명을 갖지 않는다
- 러너 여럿: 개발자마다 자기 PC 에서 하나. 자기 저장소 clone, 자기 로그인으로 에이전트를 돌리고 결과를 허브에 올린다

당장은 혼자 쓴다. 그래서 혼자 쓰는 모드(`willnew serve`)는 지금 동작 그대로 남기는 것이 첫째 조건이다.

## 지금 구조

```
willnew serve (한 프로세스)
  app.ts      HTTP, SSE, 터미널 웹소켓
  chat.ts     채널 → triage → runs.create → 봇 답글
  runs.ts     RunManager: 상태 + 저장 + 실행(워크트리, CLI, 검증, 자기 수정, 이어서 지시) + 미리보기 + 병합
  ship.ts     승인 뒤 push, gh pr, CI 대기, 배포 확인
```

`RunManager` 안에 상태와 실행이 섞여 있다. 상태 쪽(`runs` Map, `emit`, `save`, `review`, 줄 댓글, 검토함, `afterAgent`, `suggestWinner`)은 허브에 남고, 실행 쪽(`start`, `attempt`, `runCli`, `runShell`, `procs`, `pending`, `interrupted`, 미리보기, `mergeBranch`, `mergeConflicts`, 워크트리 삭제)은 러너로 간다.

다행히 실행 결과는 이미 `RunUpdate`(에이전트 patch + 이벤트)로 정규화되어 있다. 러너가 이것을 그대로 허브에 보내면 웹 UI 와 SSE 는 바꿀 것이 거의 없다.

## 무엇이 어디서 도는가

| 일 | 혼자 모드 | 팀 모드 |
|---|---|---|
| 채널, 요청 기록, 지표 | 한 프로세스 | 허브 |
| 키워드 계획 미리보기(`/api/plan`) | 한 프로세스 | 허브 |
| LLM 계획(triage, Haiku) | 한 프로세스 | 일을 가져간 러너 |
| 워크트리, 에이전트 실행, 검증, 자기 수정 | 한 프로세스 | 러너 |
| 이어서 지시, 줄 댓글 다시 맡기기 | 한 프로세스 | 허브가 받아 러너로 전달 |
| 병합 전 충돌 확인(`merge-tree`) | 한 프로세스 | 러너 (허브가 요청) |
| 터미널, 미리보기 | 한 프로세스 | 러너. 허브를 거쳐 터널 (뒷 단계) |
| 승인, 반려 기록 | 한 프로세스 | 허브 |
| 반영 `merge` | 로컬 `git merge --no-ff` | 쓰지 않음 |
| 반영 `pr` | 한 프로세스 | push 는 러너, `gh pr` 이후는 허브 |
| 배포 확인 | 한 프로세스 | 허브 |

triage 를 러너로 옮기는 이유: Haiku 호출도 AI 사용이라 허브가 누군가의 로그인을 쓰면 같은 문제가 생긴다. 허브는 키워드 규칙만 쓰고, LLM 계획은 일을 가져간 사람의 러너가 한다.

팀 모드에서 `merge` 를 빼는 이유: 허브에는 clone 이 없고, 개발자 한 명의 로컬 `main` 에 병합해 봐야 팀에 공유되지 않는다.

## 구독과 일 가져가기

러너는 인증 방식을 hello 에서 밝힌다. 인증 방식에 따라 일을 가져가는 방법이 달라진다.

| 러너 인증 | 가져가기 | 설명 |
|---|---|---|
| 개인 구독 (`claude` Pro/Max 로그인, Codex ChatGPT 로그인) | 손으로만 | 러너 주인이 웹에서 "내가 맡을게요" 를 눌렀을 때만 그 러너로 간다. 주인이 직접 시킨 일로 본다 |
| 사용량 과금 (`ANTHROPIC_API_KEY`, Bedrock, Vertex, 회사 Console 키) | 자동 가능 | 대기열에서 비어 있는 러너가 바로 가져간다 |

- 러너는 환경 변수(`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`)로 인증 방식을 판별하고, 개인 구독인데 `--claim auto` 를 주면 시작을 거부한다
- [확인 필요: 개인 구독으로 동료가 올린 요청을 손으로 가져가 처리하는 것이 Anthropic 소비자 약관과 Claude Code 이용 정책에 맞는지. OpenAI 쪽 Codex 도 같은 질문. legal-policy 에이전트로 검토하고 결과를 여기 적는다]
- 확인 결과가 "안 된다" 이면 팀 모드는 사용량 과금 러너만 받는다. 아래 설계는 그 경우에도 그대로 쓸 수 있다

## 실행 순서 (팀 모드)

1. 요청자가 채널에 `@willnew …`. 허브는 키워드 규칙으로 유형만 붙이고 요청을 대기열에 넣는다. 봇: `받았어요. @이해준 맡아 줄 사람 기다리는 중`
2. 개발자가 "내가 맡을게요" (또는 자동 러너가 가져감). 허브가 그 러너에 `job.assign` 을 보낸다
3. 러너: `git fetch origin` → `origin/<base>` 에서 워크트리 → LLM 계획 → 에이전트 → 검증 → 자기 수정. 진행은 `agent.update` 로 허브에 계속 올린다
4. 끝나면 지금과 같이 검토 대기. 검토자는 허브 웹에서 diff 를 읽고 승인
5. 승인하면 허브가 러너에 `push` 를 요청하고, push 가 끝나면 허브가 `gh pr create --repo <owner/name>` → CI 대기 → 병합 → 배포 확인
6. 요청자 답글은 지금 `chat.ts` 그대로

"내 요청" 단계에는 맨 앞에 "맡을 사람 기다리는 중" 이 하나 생긴다. 달 아이콘으로는 삭 앞 단계다.

## 프로토콜

러너가 허브로 웹소켓을 연다(`wss://hub/runner`). 러너가 NAT 뒤에 있어도 되고, 허브가 러너 주소를 알 필요가 없다. 모든 메시지는 JSON 한 줄.

러너 → 허브

```ts
{ t: "hello", proto: 1, runnerId, owner, version, auth: "subscription" | "api",
  claim: "manual" | "auto", slots: 1,
  adapters: [{ id: "claude-code", installed: true }, …],
  repos: [{ remote: "github.com/org/app", alias: "app" }] }       // 로컬 경로는 보내지 않는다
{ t: "agent.update", runId, agentId, patch?: Partial<AgentRun>, event?: AgentEvent, run?: { triage, task, title, checkCmd } }
{ t: "agent.snapshot", runId, agent: AgentRun }                   // 다시 붙었을 때 진행 중인 것 전부
{ t: "rpc.result", id, ok: true, value } | { t: "rpc.result", id, ok: false, error }
{ t: "term.data", sid, data } | { t: "term.exit", sid }
```

허브 → 러너

```ts
{ t: "job.assign", run: { id, remote, baseBranch, text, check, agents, maxAttempts, requester } }
{ t: "rpc", id, method: "steer",     params: { runId, agentId, text, by } }
{ t: "rpc", id, method: "cancel",    params: { runId, agentId } }
{ t: "rpc", id, method: "conflicts", params: { runId, agentId } }     // → boolean | null
{ t: "rpc", id, method: "push",      params: { runId, agentId } }     // → { branch, sha }
{ t: "rpc", id, method: "remove",    params: { runId } }
{ t: "rpc", id, method: "preview.start" | "preview.stop", params: { runId, agentId } }
{ t: "term.open", sid, runId, agentId, cols, rows } | { t: "term.input", sid, data } | { t: "term.resize", sid, cols, rows }
```

- 저장소는 원격 주소(`github.com/org/app`)로 맞춘다. 채널은 원격 주소를 갖고, 러너는 원격 주소와 로컬 clone 경로의 대응을 자기 설정에만 둔다. `Run.repo` 는 허브에서는 원격 주소, 러너에서는 로컬 경로
- `diff.patch` 는 1 MB 에서 자르고 잘렸다고 표시한다. 이벤트는 지금처럼 에이전트당 500 개
- `proto` 가 다르면 허브가 연결을 끊고 웹에 "러너 버전이 달라요" 를 띄운다

## 코드 경계

`RunManager` 에서 실행을 `Executor` 로 뺀다.

```ts
/** 에이전트 하나를 실제로 돌리는 쪽. 혼자 모드는 LocalExecutor, 팀 모드 허브는 RemoteExecutor(러너 연결). */
export interface Executor {
  start(run: Run, agent: AgentRun, sink: AgentSink): void;
  steer(run: Run, agent: AgentRun, text: string): void;        // 일하는 중이면 끊고 이어서, 끝났으면 다시 연다
  cancel(run: Run, agent: AgentRun): void;
  conflicts(run: Run, agent: AgentRun): Promise<boolean | null>;
  merge?(run: Run, agent: AgentRun): Promise<string>;          // LocalExecutor 만
  push(run: Run, agent: AgentRun): Promise<{ branch: string; sha: string }>;
  startPreview(run: Run, agent: AgentRun, sink: AgentSink): Promise<Preview>;
  stopPreview(run: Run, agent: AgentRun): void;
  openTerminal(run: Run, agent: AgentRun, cols: number, rows: number): Promise<TerminalStream>;
  remove(run: Run): Promise<void>;
}

export interface AgentSink {
  patch(p: Partial<AgentRun>, event?: AgentEvent): void;       // 지금의 emit(run, agent, …)
  finished(): void;                                            // 지금의 afterAgent(run)
}
```

- `LocalExecutor`: 지금 `runs.ts` 의 `start`, `attempt`, `runCli`, `followUp`, `take`, `procs`, `pending`, `interrupted`, 미리보기 코드를 거의 그대로 옮긴 것
- `RemoteExecutor`: 같은 인터페이스를 웹소켓 메시지로 바꾼다. 러너에서 온 `agent.update` 를 `sink.patch` 로 넘긴다
- 러너 프로세스(`willnew runner`)는 안에 `LocalExecutor` 를 하나 두고, 허브 메시지를 그 메서드 호출로 바꾸는 얇은 층이다
- `RunManager` 는 상태, 저장, 검토, 줄 댓글, 대기열만 맡는다. `steer` 에서 `steers` 기록과 검토 상태 초기화는 `RunManager` 가 하고, 전달은 `Executor` 가 한다
- `Shipper` 는 이미 명령 실행기를 주입받는다. 팀 모드에서는 `cwd: run.repo` 대신 `--repo owner/name` 을 붙이고, 첫 단계 `git push` 를 `executor.push` 로 바꾼다

## 사람과 권한

혼자 모드는 지금처럼 계정 없이 둔다. 팀 모드에서는 이름을 브라우저가 아니라 허브가 정해야 한다.

- 허브 설정 `members.json`: `{ name, title, role, avatar, tokenHash }`. 초대 링크에 토큰을 실어 보내고, 브라우저는 토큰만 저장
- `requester`, `by`, `reviewer` 는 요청 본문 값이 아니라 토큰에서 정한다. 지금 API 가 받는 `user`, `by`, `reviewer` 필드는 팀 모드에서 무시
- 승인과 반려는 `role: developer` 만 된다. 역할이 처음으로 권한이 된다
- 러너 토큰은 사람 토큰과 따로 두고 주인 한 명에 묶는다. "내가 맡을게요" 는 자기 러너로만 보낼 수 있다
- 터미널은 기본으로 러너 주인만 연다(`--terminal owner`). 다른 개발자에게 열어 주려면 러너 쪽에서 켠다. 터미널은 남의 PC 셸이기 때문이다

## 무엇이 러너 PC 를 떠나는가

- 허브로 가는 것: 요청 문장, 계획, 에이전트 이벤트(도구 결과 일부에 파일 내용이 섞인다), diff, 검증 출력, 요약, 비용. 터미널을 열면 그 화면 전체
- 허브로 가지 않는 것: 로컬 경로, AI 로그인 정보, 환경 변수, 워크트리 전체
- 허브는 이것을 `~/.willnew/runs/*.json` 에 그대로 둔다. 허브는 회사 내부망이나 VPN 안에 두고, 밖에 둘 거면 TLS 를 앞에 붙인다
- 남이 쓴 요청 문장이 내 PC 의 에이전트 프롬프트로 들어온다. Claude 는 지금의 `--allowedTools` 범위를 유지하고, Codex 는 Windows 에서 `danger-full-access` 라 팀 모드 러너에서는 기본으로 끄고 주인이 켜야 쓰게 한다

## 고장 처리

| 상황 | 동작 |
|---|---|
| 러너가 실행 중 끊김 | 허브는 2분 동안 상태를 그대로 두고 "러너 연결 끊김" 만 표시. 다시 붙으면 `agent.snapshot` 으로 덮어쓴다 |
| 2분 안에 안 돌아옴 | 에이전트를 `cancelled`(사유: 러너 끊김)로. 웹에 "다른 러너로 다시 맡기기" 버튼 |
| 러너 재시작 | 지금처럼 진행 중이던 것은 `cancelled` 로 올린다. 워크트리는 남는다 |
| 허브가 꺼짐 | 러너는 계속 일한다. 다시 붙으면 진행 중인 것과 끝난 것의 snapshot 을 보낸다 |
| 두 러너가 같은 일을 가져가려 함 | 배정은 허브만 한다. 먼저 온 쪽에 `job.assign`, 늦은 쪽은 버튼이 사라진다 |
| push 실패 (러너 git 인증) | 지금의 `ci_failed` 와 같은 자리에 `git push` 실패로 표시 |
| 러너 슬롯이 다 참 | 허브 대기열에 남는다. 자동 러너는 슬롯이 비면 가져간다 |

## 구현 순서

각 단계가 끝날 때 기존 테스트가 모두 통과해야 하고, 혼자 모드는 단계마다 그대로 쓸 수 있어야 한다.

1. Executor 분리: 한 프로세스 안에서 `RunManager` → `RunManager` + `LocalExecutor`. 동작 변화 없음. 가짜 Executor 로 `RunManager` 단위 테스트 추가
2. 러너 프로세스와 프로토콜: `willnew hub`, `willnew runner`, `RemoteExecutor`. 한 PC 에서 루프백으로 허브와 러너를 띄워 오프라인 script 어댑터로 e2e (맡기기 → 이어서 지시 → 줄 댓글 → 승인 → push)
3. 사람: `members.json`, 토큰에서 이름 정하기, 승인 권한, 러너 주인 묶기
4. 팀 반영: 허브의 GitHub 토큰으로 `gh pr … --repo`, push 는 러너. 가짜 `gh` 테스트 재사용
5. 대기열 화면: "내가 맡을게요", 러너 상태(연결, 인증 방식, 슬롯), 내 요청의 "맡을 사람 기다리는 중"
6. 터미널, 미리보기 터널

1단계는 팀 기능과 상관없이 `runs.ts` 를 정리하는 일이라 혼자 쓰는 동안 아무 때나 해도 된다. 2단계부터가 팀용이다.

## 정하지 않은 것

- 개인 구독 러너를 손으로 가져가는 방식이 약관상 되는지 (위 확인 필요 항목)
- 허브를 어디에 둘지: 팀원 PC 하나, 사내 서버, 작은 클라우드 VM
- PR 작성자: 허브의 봇 계정 토큰으로 할지, GitHub App 으로 할지. 지금 설계는 봇 계정 토큰
- 자기가 맡은 일을 자기가 승인해도 되는지. 지금 혼자 모드는 된다. 팀 모드에서 막을지는 팀 규칙으로 남긴다
- 한 채널에 저장소 여럿
- 비용 지표: 개인 구독 러너는 비용이 `null` 이라 팀 합계가 비게 된다. 토큰 수로만 보여 줄지
