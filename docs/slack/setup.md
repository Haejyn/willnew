# Slack 연결

Slack 채널에서 `@willnew …` 라고 쓰면 그 메시지의 스레드가 요청 하나가 된다. 되묻기 → 제안 → 개발자 확인 → 결과 → 요청자 확인 → 검토 → 병합 → 배포 답장까지 같은 스레드에서 이어진다. 웹 채팅과 같은 요청 기록을 쓰므로 웹에서도 그대로 보인다.

Socket Mode 로 돈다. 허브가 Slack 쪽으로 연결을 열기 때문에 공개 URL 이나 방화벽 열기가 필요 없고, 사내망 PC 에서 그대로 띄울 수 있다.

## 1. 앱 만들기

1. https://api.slack.com/apps 에서 Create New App → From a manifest
2. 워크스페이스를 고르고 [`manifest.yml`](./manifest.yml) 내용을 붙여 넣는다
3. Install to Workspace 로 설치한다

매니페스트가 요청하는 권한은 아래 넷이다. 실제로 부르는 API 만 넣었다.

| 권한 | 쓰는 곳 |
|---|---|
| `app_mentions:read` | `@willnew` 멘션 받기 |
| `chat:write` | 요청 카드와 스레드 답글 올리고 고치기, 권한 안내를 본인에게만 보이게 |
| `files:write` | 전후 스크린샷을 스레드에 올리기 (`files.uploadV2`) |
| `channels:history` | 되묻기에 "직접 쓸게요" 로 스레드 답글을 단 것 읽기 |

비공개 채널에서도 쓰려면 `groups:history` 권한과 `message.groups` 이벤트를 더한다. 버튼과 모달은 따로 권한이 필요 없다.

## 2. 토큰 두 개

| 토큰 | 어디서 | 환경 변수 |
|---|---|---|
| 봇 토큰 `xoxb-…` | OAuth & Permissions → Bot User OAuth Token | `SLACK_BOT_TOKEN` |
| 앱 토큰 `xapp-…` | Basic Information → App-Level Tokens → Generate, 권한 `connections:write` | `SLACK_APP_TOKEN` |

토큰은 명령줄 인자로 받지 않는다. 셸 기록과 프로세스 목록에 남기 때문이다.

## 3. 채널에 초대

willnew 를 쓸 채널마다 `/invite @willnew` 를 한다. 채널 ID 는 채널 이름 클릭 → 맨 아래 `C0123ABCD` 형태로 보인다.

## 4. 사람 목록

Slack 계정마다 willnew 이름과 역할을 정해야 버튼 권한을 가릴 수 있다. 되묻기에 답하기, 의도대로예요, 다시 봐 주세요는 요청한 사람만 누를 수 있다. 진행, 고쳐서 진행, 직접 할게, 거절, 요청자 확인 건너뛰기, 결과 승인과 반려는 `developer` 만 된다. 목록에 없는 사람이 멘션하거나 버튼을 누르면 본인에게만 보이는 안내가 간다.

`members.json` 과 같은 칸을 쓰는 파일을 만든다. Slack ID 는 프로필 → 더 보기 → 멤버 ID 복사.

```json
[
  { "name": "이해준", "role": "developer", "slackId": "U01AAAA" },
  { "name": "한지우", "role": "requester", "title": "디자인", "slackId": "U02BBBB" }
]
```

## 5. 허브 실행

```bash
export SLACK_BOT_TOKEN=xoxb-…
export SLACK_APP_TOKEN=xapp-…
willnew serve --repo ~/code/app --check "npm test" --reviewers 이해준 \
  --slack --slack-channel C0123ABCD:backend --slack-members people.json \
  --slack-web-url http://my-host:7777
```

| 옵션 | 뜻 |
|---|---|
| `--slack` | Slack 앱을 켠다. 없으면 Slack 코드는 아예 불러오지 않는다 |
| `--slack-channel <Slack 채널 ID>:<willnew 채널>` | 채널 대응. 여러 번 줄 수 있다. willnew 채널은 `backend`, `data`, `content-ops` 중 하나이고, 빼면 `backend` |
| `--slack-members <파일>` | 위 사람 목록 |
| `--slack-web-url <주소>` | 카드의 "웹에서 보기" 링크와, 다시 봐 주세요에서 화면 위에 상자를 그리러 갈 링크. 다른 사람 PC 에서 열리는 주소여야 한다 |

검토를 맡을 개발자는 `--reviewers` 의 첫 사람(요청자가 아닌 사람)이다. 미리보기와 전후 스크린샷이 붙으려면 `--preview` 도 함께 준다. PR 로 반영하려면 `--ship pr`, 배포 확인까지 하려면 `--deploy-check` 를 준다. 스레드와 요청의 대응은 `~/.willnew/slack/threads.json` 에 남아서, 허브를 다시 띄워도 같은 메시지를 이어서 고친다.

지금은 혼자 모드(`willnew serve`)에 붙어 있다. 팀 모드 허브가 생기면 `willnew hub --slack` 으로 옮기고, 사람 목록은 허브의 `members.json` 을 그대로 쓴다.

## 스레드에서 보이는 것

| 단계 | 스레드 |
|---|---|
| 멘션 | 첫 봇 메시지로 요청 카드. 상태가 바뀌면 같은 메시지가 고쳐진다 |
| 되묻기 | 질문마다 선택지 버튼과 "직접 쓸게요". 직접 쓰면 다음 스레드 답글을 답으로 받는다 |
| 제안 | 요청자용 요약, 그 아래 작게 개발자용 한 줄. 진행, 고쳐서 진행, 직접 할게, 거절 |
| 요청자 확인 | 미리보기 링크와 전후 스크린샷. 의도대로예요, 다시 봐 주세요, 개발자용 건너뛰기 |
| 검토 | `@개발자 검토 차례예요. 테스트 7개 통과, main과 충돌 없음` 과 승인, 반려 |
| 반영 | PR, CI, 병합, 배포가 한 메시지에 줄로 쌓인다 |
| 답장 | 승인한 개발자 이름으로 요청자에게 쉬운 말 답장 |

모든 사람이 같은 메시지를 보기 때문에 본문은 요청자용으로 쓰고, 개발자용 기술 내용은 그 아래 작은 글씨로 접어 둔다. 명세 전체와 제안 상세는 "개발자용 보기" 를 누르면 본인에게만 보인다.

## 안 될 때

| 증상 | 확인할 것 |
|---|---|
| `invalid_auth` 로 시작이 안 된다 | 봇 토큰이 `xoxb-`, 앱 토큰이 `xapp-` 인지, 앱 토큰에 `connections:write` 가 있는지 |
| 멘션해도 답이 없다 | 채널에 `/invite @willnew` 했는지, `--slack-channel` 의 ID 가 맞는지 |
| "등록되지 않은 Slack 계정" 안내가 온다 | 사람 목록의 `slackId` |
| 스크린샷이 안 붙는다 | `--preview` 와 `playwright-core` 설치. 없으면 스크린샷 없이 확인 버튼만 나온다 |
