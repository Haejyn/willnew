# 팀 모드 설정

허브 하나와 개발자마다 러너 하나로 돈다. 허브는 채널, 요청 기록, 검토, 반영, 지표를 맡고 AI 로그인을 갖지 않는다. 러너는 개발자 PC 에서 자기 clone 과 자기 Claude Code 로그인으로 에이전트를 돌리고 결과를 허브에 올린다. 설계는 [hub-runner.md](../design/hub-runner.md).

필요한 것: Node 22 이상, git. 허브 PC 에는 PR 을 올릴 `gh` 로그인, 러너 PC 에는 `claude` 로그인.

혼자 쓸 때는 지금처럼 `willnew serve` 하나면 된다. 아래는 팀으로 쓸 때만.

## 1. 허브 띄우기

```bash
willnew hub --repo-remote github.com/acme/app --check "npm test" --reviewers 이해준 --host 0.0.0.0 --port 7777
```

- 기록은 `~/.willnew/hub` 에 남는다. `WILLNEW_HOME` 을 주면 그 아래 `hub`
- 사람 목록은 `~/.willnew/members.json`. 다른 파일을 쓰려면 `--members <경로>`
- 자기 요청이나 자기가 맡은 결과를 자기가 승인하지 못하게 하려면 `--no-self-approve`
- 허브에 회사 `ANTHROPIC_API_KEY` 가 있으면 맡기 전 계획(되묻기, 명세, 제안)을 허브가 만든다. 없으면 요청은 맡을 사람을 기다리고, 맡은 개발자의 러너가 계획을 만든다
- 다른 PC 에서 들어오려면 `--host 0.0.0.0`. 허브는 사내망이나 VPN 안에 두고, 밖에 둘 거면 앞에 TLS 를 붙인다
- 반영은 PR 만 한다. 허브가 러너에 push 를 시키고, 허브의 `gh` 로 PR, CI 대기, 병합을 한다

## 2. 사람 초대

```bash
willnew invite 이해준 --role developer --title 백엔드 --slack-id U01AAAA --url http://hub-host:7777
willnew invite 한지우 --title 디자인 --slack-id U02BBBB --url http://hub-host:7777
```

초대 링크는 한 번만 보인다. 받은 사람이 링크를 열면 브라우저가 토큰을 기억하고, 그 뒤로는 그 이름으로 들어온다. 이름과 역할은 허브가 정하고 웹에서 바꿀 수 없다. 링크를 잃어버리면 같은 명령을 다시 돌려 새 링크를 만든다. 옛 링크는 그때 막힌다. 허브를 다시 띄울 필요는 없다.

| 역할 | 할 수 있는 것 |
|---|---|
| `developer` | 내가 맡을게요, 제안 확인, 결과 승인과 반려, 요청자 확인 건너뛰기, 요청 취소, 실행 삭제, 미리보기 켜고 끄기 |
| `requester` (기본) | 요청, 되묻기 답, 화면 확인(의도대로예요, 다시 봐 주세요) |

이어서 지시와 줄 댓글은 누구나 남길 수 있다. 다만 아래 개인 구독 규칙을 탄다.

## 3. 러너 토큰

```bash
willnew runner-token 이해준
```

러너 토큰은 사람 토큰과 따로 있고, 그 사람 한 명에 묶인다. 허브 PC 에서 만들어 러너 주인에게 전한다. 한 사람이 러너를 여럿 둘 수 있다.

## 4. 러너 띄우기 (개발자 PC)

```bash
export WILLNEW_RUNNER_TOKEN=<러너 토큰>
willnew runner --hub ws://hub-host:7777/runner --repo ~/code/app --preview "npm run dev -- --port {port}" --preview-base-url "http://my-pc:{port}"
```

- `--repo` 는 내 clone. origin 주소가 허브의 `--repo-remote` 와 같아야 맡을 수 있다
- 기록과 워크트리는 `~/.willnew/runner` 에 남는다. 로컬 경로와 로그인 파일은 허브로 가지 않는다
- `--preview-base-url` 이 없으면 요청자는 미리보기 링크 없이 전후 스크린샷만 본다
- 웹 설정 칸(왼쪽 아래 아바타)의 "내 러너" 에 연결, 구독인지 API 인지, 슬롯, 마지막 연결이 보인다

## 5. Slack 연결

앱 만들기와 토큰은 [Slack 연결](../slack/setup.md). 같은 허브에 옵션만 더한다.

```bash
export SLACK_BOT_TOKEN=xoxb-…
export SLACK_APP_TOKEN=xapp-…
willnew hub --repo-remote github.com/acme/app --slack --slack-channel C0123ABCD:backend --slack-web-url http://hub-host:7777
```

Slack 계정은 `members.json` 의 `slackId` 로 사람과 이어진다(`invite --slack-id`). Slack 에서 누르는 승인 버튼도 `--no-self-approve` 를 따른다.

## 6. 첫 요청

1. 한지우가 Slack 이나 웹 채널에 `@willnew 결제 버튼 여백 좀 넓혀 주세요`
2. 봇이 "받았어요. 맡을 사람 기다리는 중" 이라고 답한다
3. 이해준이 웹의 내 차례에서 "맡을 사람 기다리는 요청" 의 내가 맡을게요를 누른다. 러너가 둘 이상이면 고른다
4. 이해준의 러너가 되묻기를 만들고, 한지우가 답하면 명세와 제안을 만든다
5. 이해준이 진행을 누르면 같은 러너가 작업하고 테스트로 확인한다. 화면 요청이면 한지우가 전후 화면을 본다
6. 승인하면 러너가 브랜치를 push 하고 허브가 PR → CI → 병합까지 한 뒤 한지우에게 답한다

## 개인 구독 러너 규칙

Claude Pro, Max 같은 개인 구독은 본인이 직접 쓰는 용도다. 그래서 구독 로그인으로 띄운 러너는 이렇게 동작한다.

- 주인이 내가 맡을게요를 누른 일만 한다. 대기열에서 알아서 가져가지 않고, `--claim auto` 로 띄우면 거부된다
- 다른 사람이 보낸 이어서 지시, 줄 댓글, 다시 봐 주세요는 바로 러너로 가지 않고 "확인 뒤 이어서 작업" 에 쌓인다. 봇은 "이해준님 확인 뒤에 이어서 작업해요" 라고 알린다. 주인이 내용을 보고 이어서 실행을 눌러야 러너로 간다
- 비용은 남기지 않고, 지표에서는 구독으로 따로 센다. 토큰 수는 보인다

`ANTHROPIC_API_KEY`, Bedrock, Vertex 같은 사용량 과금 인증으로 띄운 러너는 이 제한 없이 바로 받고, `--claim auto` 로 대기열의 일을 알아서 가져갈 수 있다. 근거는 [hub-runner.md 의 약관 검토](../design/hub-runner.md#약관-검토-2026-10-23).

## 안 될 때

| 증상 | 확인할 것 |
|---|---|
| 웹이 "초대 링크로 들어와 주세요" 만 보인다 | 초대 링크를 이 브라우저에서 열었는지. 다시 받으려면 `willnew invite <이름>` |
| 러너가 바로 끊기고 "러너 토큰을 확인해 주세요" | `willnew runner-token` 으로 만든 토큰인지, 허브가 같은 `members.json` 을 읽는지 |
| 내가 맡을게요 대신 "러너를 먼저 연결해 주세요" | 내 이름으로 만든 러너 토큰으로 러너를 띄웠는지 |
| "이 러너에는 그 저장소가 없어요" | 러너 clone 의 origin 주소와 허브의 `--repo-remote` |
| 요청이 정리 중에서 멈췄다 | 러너가 끊겼다가 돌아왔으면 요청 카드의 "내 러너로 다시 정리" 를 누른다. 멈춘 단계부터 다시 한다 |
| PR 을 올리지 못했다 | 러너 PC 의 git push 권한, 허브 PC 의 `gh auth status` |
