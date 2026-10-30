# 경쟁 분석 갱신 (2026-10-30 기준)

조사 방법: 웹 검색과 공식 문서 직접 열람. 공식 페이지에서 확인한 항목은 "확인", 제3자 블로그나 검색 요약에만 있는 항목은 "미확인(2차)"로 표시했다. 가격은 벤더마다 자주 바뀌고 2차 자료끼리 충돌하는 곳이 많아 계약 전 재확인이 필요하다.

## 1. 제품별 조사

### Atlassian Rovo (Jira Triage, Bug Report Assistant, JSM AI)
- 하는 일: Jira 안에서 사전 제작 에이전트가 작동한다. Bug Report Assistant는 버그 생성 시점이나 버그 라벨이 붙은 시점에 재현 단계, 환경, 기대/실제 동작을 요구하고, 정보가 부족하면 작성자에게 댓글을 단다. Service Triage 에이전트는 "work item created" 트리거에서 중복 후보, 컴포넌트, 우선순위, 담당자를 제안한다. (미확인(2차): https://community.atlassian.com/forums/Jira-questions/How-are-you-using-Rovo-in-Jira-Software-to-actually-reduce/qaq-p/3252774 , https://community.atlassian.com/forums/App-Central-articles/Rovo-Agents-How-To-Use-and-Transform-Your-Jira-Workflows/ba-p/3117887)
- 티켓 생성 전 되묻기: 아니오. 티켓이 만들어진 뒤 댓글로 부족한 정보를 요청한다.
- 고객 말과 코드 매핑: 없음. Confluence/Jira 데이터 검색 수준.
- 배포: 클라우드 전용(Cloud 플랜 기준).
- 역번역: 확인되지 않음.
- 가격(확인): Jira Standard/Premium/Enterprise Cloud에 포함. Jira/Confluence 사용자당 월 25/70/150 크레딧 포함, 초과분 $0.01/크레딧. https://www.atlassian.com/software/rovo/pricing
- 알려진 문제(미확인(2차)): 에이전트가 잘못된 이슈 타입으로 작업 항목을 만드는 버그 ROVO-370 보고. https://community.atlassian.com/forums/Rovo-questions/Rovo-agent-creating-work-items-with-the-wrong-issue-type/qaq-p/3116627
- 대상: 중대형, Jira 도입 팀.

### Linear (Asks, Triage Intelligence, Linear agent, Customer Requests)
- Triage Intelligence(확인): LLM으로 팀, 프로젝트, 담당자, 라벨과 중복/연관 이슈를 제안하고 자동 적용 설정 가능. Business/Enterprise 플랜. 요청자에게 질문하지 않는다. https://linear.app/docs/triage-intelligence
- Linear agent(확인): Intercom, Zendesk 연동에서 버튼 한 번으로 지원 티켓 전체 대화를 읽어 이슈를 만들고 요약, 핵심 정보, 스크린샷을 붙이며, 한 대화에서 여러 이슈도 만든다. 각 이슈는 해당 팀 triage 큐로 가고 고객이 귀속된다. 되묻기 여부는 페이지에 언급 없음. Business/Enterprise. https://linear.app/changelog/2025-12-11-linear-agent-for-intercom-zendesk-gong
- Asks(미확인(2차)): Slack 등에서 비 Linear 사용자의 요청을 받아 triage로 넣는다. 필드와 triage 라우팅(라우팅은 Enterprise). https://linear.app/docs/triage , https://linear-web.pages.dev/changelog/2025-06-05-asks-fields-and-triage-routing
- Customer Requests(미확인(2차)): 지원 시스템과 Slack 요청을 고객에 귀속해 우선순위화.
- 코드 매핑: 없음(이슈 그래프 기준 유사도). 클라우드 전용. 역번역: 없음(연동 도구로 상태만 되돌리는 방식).
- 가격: Business 이상 필요. 정확한 단가는 공식 페이지에서 확인하지 못함(미확인).
- 대상: 스타트업부터 중견. 위협도가 가장 높다.

### Plain
- 하는 일: B2B 지원 플랫폼(Slack, Teams, 이메일 통합). Linear 연동, AI 에이전트 Ari, 내부용 Sidekick. (미확인(2차): https://www.oflight.co.jp/ja/columns/plain-b2b-ai-support-platform-slack-ari-sidekick-2026 )
- 되묻기: Ari는 고객 응답용이며 엔지니어링 티켓용 사전 명세화는 확인하지 못함.
- 가격: 공식 페이지 https://www.plain.com/pricing-new-brand 에는 Foundation 월 $35/시트로 나오지만 제3자는 $199/시트(연 결제)로 보고하며 충돌한다. 2026년 5월 인상 보고 https://pricingsaas.com/companies/plain/diffs/2026W19 . 재확인 필요.
- 클라우드 전용(자체 호스팅 옵션을 찾지 못함). 대상: 개발자 대상 B2B SaaS의 소~중규모 지원팀.

### Pylon
- 가격(확인): Professional $89/시트/월(연 계약), Advanced $139, Enterprise 견적. 에이전트(Assist, Support, Slack Agent, Automations)는 크레딧제. https://www.usepylon.com/pylon-facts (2차 자료는 Starter $59 등 다른 수치를 보고하므로 공식을 우선)
- 연동(확인): Jira, Linear, GitHub Issues, Asana, Shortcut. Linear 연동은 양방향 댓글, Linear 이슈 종료 시 연결된 대화를 "Waiting on You"로 전환(미확인(2차)): https://kb.help.usepylon.com/articles/2402818644-how-does-the-linear-integration-work
- 되묻기, 코드 매핑, 역번역: 확인되지 않음. 클라우드. 대상: B2B 지원/CS 팀, 1,500개 이상 고객사.

### Unthread
- 하는 일: Slack, Teams, 이메일을 티켓화하는 AI 헬프데스크. Jira, Linear, Zendesk 등 연동. 주 용도는 내부 IT/HR/운영 요청이며 고객 버그 에스컬레이션 전용은 아님(2차). https://unthread.io/ , https://www.featurebase.app/blog/unthread-io-alternatives
- 가격: 2차 자료에 월 $50 시작이라는 언급이 있으나 충돌(미확인). 클라우드. 대상: 소~중규모.

### Thena
- Slack 기반 B2B 고객 지원 + AI 에이전트. 2차 자료상 Starter $29, Standard $79, Enterprise $119 /사용자/월(미확인). 공식 문서는 모든 플랜에 AI 포함이라고만 확인. https://docs.thena.ai/guides/billing/pricing
- 클라우드. 되묻기, 코드 매핑, 역번역: 확인되지 않음.

### Intercom Fin
- 고객 대면 AI 에이전트. 2차 자료에서 해결당 $0.99(좌석 별도). https://www.gleap.io/blog/intercom-fin-ai-pricing-2026 (미확인(2차))
- Linear 연동: Intercom 사이드바에서 수동으로 Linear 이슈 생성. Fin Tasks로 Linear 이슈를 자동 생성하는 사례가 커뮤니티에 있으나 대화 URL을 참조하지 못하는 한계(미확인(2차)): https://community.intercom.com/ideas/include-conversation-url-or-conversation-id-in-fin-tasks-13648
- 엔지니어링 명세용 되묻기, 코드 매핑: 없음. 클라우드. 대상: 전 규모. Linear agent가 Intercom과 직접 연동되어 있어 티켓 변환은 Linear 쪽에서 이뤄진다.

### Zendesk AI agents
- 가격(미확인(2차)): 해결 단위 과금. 2026-05-18부터 assisted escalation / contained / verified 세 단계로 나누고 verified만 포함량에서 차감. 초과 단가 약 $1.5~2.0는 추정치. https://eesel.ai/blog/zendesk-ai-pricing/
- Jira 연동(확인): Zendesk Support for Jira가 필드 동기화를 위해 Jira 웹훅을 요구하며 관리자가 수동 생성. https://support.zendesk.com/hc/en-us/articles/10687180502810-Configuring-a-Jira-Cloud-webhook-for-field-syncing
- 엔지니어링 명세용 되묻기: 없음. 클라우드 전용. 대상: 중대형.

### Freshdesk Freddy
- 가격(미확인(2차), 출처 간 충돌): Freddy AI Agent 세션당 과금($100/1,000세션 또는 $49/100세션으로 상이), Copilot $29/에이전트. 공식 가격 페이지는 열람하지 못했다. https://www.eesel.ai/blog/freshdesk-freddy-ai-pricing
- 엔지니어링 티켓 생성 전 되묻기, 코드 매핑: 확인되지 않음. 클라우드. 대상: 소~중규모 헬프데스크.

### 채널톡 ALF
- 상태(확인): ALF v2는 2025-11-28 업그레이드, 얼리 스테이지 플랜은 같은 날부터 ALF 사용 불가. https://docs.channel.io/updates/ko/categories/%EC%A7%80%EB%82%9C-%EC%97%85%EB%8D%B0%EC%9D%B4%ED%8A%B8-5ed3828c
- 2026-10-16 "채널웍스 AI 에디션" 출시. 고객 ALF는 무료 플랜 포함 모든 플랜에서 시작 가능. 크레딧제(MU, ALF, 워크플로우가 하나의 크레딧에서 차감). 월 15만 원 크레딧 플랜은 다팀 대기업용으로 소개되고 VAT 별도(검색 요약, 원문: https://docs.channel.io/updates/ko/articles/%EA%B3%B5%EC%A7%80-10%EC%9B%94-16%EC%9D%BC-%EC%B1%84%EB%84%90%EC%9B%8D%EC%8A%A4-AI-%EC%97%90%EB%94%94%EC%85%98-%EC%B6%9C%EC%8B%9C-%EB%B0%8F-%EA%B0%80%EA%B2%A9-%EC%95%88%EB%82%B4-%EA%B8%B0%EC%A1%B4-%ED%94%8C%EB%9E%9C%EC%9A%94%EA%B8%88-%EC%9C%A0%EC%A7%80-b3dbef91 ). 소규모 팀 정확 월 요금은 확인하지 못함.
- 기능: 고객 응대용 AI. 엔지니어링 티켓 명세용 되묻기, 코드 매핑은 확인되지 않음. 클라우드. 대상: 한국 중소 서비스 기업 다수.
- API와 웹훅: 5절.

### Jam.dev
- 2차: 재현 영상, 콘솔 로그, 네트워크 요청 자동 수집. AI가 제목, 요약, 재현 단계를 제안. 2026-03 MCP 도구로 코딩 에이전트에 로그와 영상을 노출. Linear, Jira, Slack 연동. https://jam.dev/ai , https://jam.dev/docs/integrations-overview
- 가격(2차): 무료 월 30 Jam, Team 월 $14/제작자(연 결제). 일부 자료는 다른 수치.
- 되묻기: 없음(증거 직접 수집이 방식). 역번역: 없음. 클라우드. 대상: 소~중규모. 고객 화면을 CS가 직접 못 찍는 상황이 빈틈.

### Marker.io
- 2차: 위젯 기반 시각 피드백, Jira/Linear/GitHub 양방향 동기화, 2026-03경 번역, 설명 재작성, 제목 생성 베타 AI. 가격은 소스마다 $39~$199로 충돌(미확인). https://www.stork.ai/en/marker-io , https://frontdeskreview.com/software/bug-reporting/marker-io/
- 되묻기: 없음. 클라우드. 대상: 에이전시, QA 팀.

### Sentry (Seer, user feedback)
- Seer(확인): 이슈 근본 원인 분석, PR 생성, 외부 코딩 에이전트(Claude Code, Cursor Cloud Agents, GitHub Copilot)로 인계, 코드 리뷰. 활성 기여자(월 PR 2개 이상) 과금. 저장소 연결은 GitHub.com, GitLab.com 클라우드만. 자체 호스팅 Sentry에서의 Seer 가용 여부는 문서에 없음. https://docs.sentry.io/product/ai-in-sentry/seer/
- 가격(2차): 활성 기여자당 월 $40. https://www.businesswire.com/news/home/20260127739891/en/Sentry-Adds-Local-Development-and-Code-Review-Debugging-to-Seer
- 되묻기: 에러 데이터 기반이며 CS와 대화하지 않는다. User feedback 위젯 쪽은 이번에 열람하지 못함. 대상: 개발팀.

### GitHub Copilot coding agent
- 확인: 저장소를 조사, 계획, 백그라운드 구현하고 PR 전에 사용자가 검토, 개선 요청 가능. GitHub Actions 세션은 자체 호스팅 러너 지원, 클라우드 샌드박스는 미지원. 되묻기 여부는 문서에 없음. https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
- 가격(미확인(2차)): 2026-06-01부터 사용량 기반 AI Credits(1 credit = $0.01)로 전환했다는 보도. https://dev.to/hassann/github-copilot-pricing-changes-ai-credits-system-explained-44c1
- 입력은 개발자 쪽 이슈. CS 대화 단계 없음.

### Devin
- 2차: 진입 월 $20(ACU 종량), Slack, Linear, Jira에서 할당 후 PR 반환. 상위 Team 플랜 가격은 자료마다 충돌. https://pricepertoken.com/coding-assistants/devin , https://automationatlas.io/answers/devin-pricing-explained-2026/ (미확인). 클라우드. 개발자 대상.

### Cursor (Cloud Agents, 구 Background Agents)
- 확인(공식 도움말): Slack @Cursor 멘션, Linear 연동으로 클라우드 에이전트 시작, 사용량 기반 과금 활성화 필요. https://cursor.com/help/integrations/third-party
- Automations(2026-03 출시, 2차): Slack 메시지, 신규 Linear 이슈 등 이벤트로 에이전트 시작. https://ecorpit.com/cursor-automations-event-triggered-coding-agents-2026/
- 가격 미확인. 클라우드. 개발자 대상.

### Claude Code GitHub 연동
- 확인: 이슈나 PR의 @claude 멘션으로 코드 분석, PR 생성, 구현. `/install-github-app`으로 설치, GitHub Actions 위에서 동작하고 API 사용량 별도 과금, 쓰기 권한 사용자만 트리거(트리거 제한은 2차). Bedrock/Vertex 지원. https://code.claude.com/docs/en/github-actions
- willnew와는 경쟁보다 하류 파트너. `willnew work`가 여는 Claude Code와 같은 계열이다.

### 신규 진입자(2025~2026)
- Cotera(2차, 단일 리뷰 기사): 버그성 티켓을 감시, 클러스터링해 고객 맥락이 붙은 단일 Linear 이슈 생성. 되묻기, 자체 호스팅 여부 미확인. https://cotera.co/articles/best-ai-customer-support-tools
- Forethought(2차, 벤더성): Zendesk와 함께 버그 신고를 엔지니어링 지원으로 라우팅. 미확인. https://www.mavenagi.com/blog/ai-ticketing-software
- iTop AI Assistant(Docker Hub): 접수 티켓이 모호하면 질문을 1개씩, 티켓당 기본 최대 3개 되묻고 엔지니어에게 넘길 준비를 한다. 자체 호스팅. ITSM(iTop) 전용. https://hub.docker.com/r/knowitop/itop-ai-assistant
- ChattermateAI: 셀프 호스팅 시 티켓 조사 기능 제한 없음(오픈소스), PII 마스킹된 증거. https://github.com/chattermate/chattermate.chat/releases/tag/v1.0.16
- Harmonia(delosx): 자체 호스팅이지만 BSL이라 OSS 아님. 1차 응대 후 사람에게 에스컬레이션. https://delosx.com/harmonia/
- 검색으로는 "CS 대화, 되묻기, 근거 붙은 개발 티켓, 터미널 작업, 역번역" 전체를 묶은 제품을 찾지 못했다. 부재 증명이 아니라 검색 한계다.

## 2. 비교표

사전 되묻기: 티켓이 만들어지기 전 요청자와 대화하며 빈 정보를 묻는가. 코드 매핑: 고객 표현을 화면/식별자로 연결하는가. 역번역: 개발자 답을 CS용 쉬운 말로 바꾸는가.

| 제품 | 사전 되묻기 | 코드 매핑 | 배포 | 역번역 | 가격(요약) | 대상 규모 |
|---|---|---|---|---|---|---|
| Atlassian Rovo | 사후(생성 뒤 댓글) | 없음 | 클라우드 | 없음 | Jira 플랜 포함, 초과 $0.01/크레딧(확인) | 중대형 |
| Linear (Triage Intel., agent) | 확인 안 됨 | 없음 | 클라우드 | 없음 | Business 이상(단가 미확인) | 소~중 |
| Plain | 확인 안 됨 | 없음 | 클라우드 | 없음 | $35 또는 $199/시트로 충돌 | 소~중 B2B |
| Pylon | 확인 안 됨 | 없음 | 클라우드 | 없음 | $89/$139 시트(확인) | B2B 중규모 |
| Unthread | 확인 안 됨 | 없음 | 클라우드 | 없음 | $50~(미확인) | 소~중 |
| Thena | 확인 안 됨 | 없음 | 클라우드 | 없음 | $29~119 시트(미확인) | 소~중 |
| Intercom Fin | 고객 대상 답변용 | 없음 | 클라우드 | 없음 | 해결당 $0.99(2차) | 전 규모 |
| Zendesk AI | 고객 대상 답변용 | 없음 | 클라우드 | 없음 | 해결 단위(2차) | 중대형 |
| Freshdesk Freddy | 고객 대상 답변용 | 없음 | 클라우드 | 없음 | 세션 단위(충돌) | 소~중 |
| 채널톡 ALF | 고객 대상 답변용 | 없음 | 클라우드 | 없음 | 크레딧제(소규모 단가 미확인) | 한국 중소 |
| Jam.dev | 없음(증거 수집) | 로그/네트워크 수집 | 클라우드 | 없음 | 무료~$14/제작자(2차) | 소~중 |
| Marker.io | 없음 | 환경 메타 수집 | 클라우드 | 없음 | $39~$199(충돌) | 에이전시 |
| Sentry Seer | 해당 없음 | 스택트레이스 기반 코드 | 클라우드(Seer) | 없음 | $40/기여자(2차) | 개발팀 |
| Copilot coding agent | 문서에 없음 | 저장소 직접 | 클라우드, Actions는 자체 러너 | 없음 | 크레딧제(2차) | 개발팀 |
| Devin | 미확인 | 저장소 직접 | 클라우드 | 없음 | $20~(충돌) | 개발팀 |
| Cursor Cloud Agents | 미확인 | 저장소 직접 | 클라우드 | 없음 | 사용량(미확인) | 개발팀 |
| Claude Code GitHub | 없음(@claude 지시 기반) | 저장소 직접 | Actions | 없음 | API+Actions 분(확인) | 개발팀 |
| iTop AI Assistant | 있음(최대 3문) | 없음 | 자체 호스팅 | 없음 | 미확인 | iTop 사용 조직 |

## 3. willnew 차별점 평가

1. 티켓 생성 전 되묻기: 부분적으로 선점됨. Rovo Bug Report Assistant와 iTop 플러그인이 되묻기 자체를 한다. Rovo는 생성 후, iTop은 ITSM 전용이고 둘 다 팀 용어 사전이나 코드 식별자와 묶지 않았다. 되묻기 자체는 약한 차별점이고, "용어 사전과 과거 해결 티켓에 근거한 되묻기"가 남는 자리다.
2. 필드별 출처 표시: 조사한 제품 중 필드 단위 출처를 명시한 곳을 찾지 못했다. 실재로 보이나 부재 증명은 아니다.
3. 용어 사전으로 고객 말을 화면/코드 식별자에 매핑: 조사 범위에서 동일 기능을 찾지 못했다. 가장 실재하는 차별점. Linear agent가 대화를 읽고 이슈를 만드는 단계까지 와 있어 코드 인덱스를 붙이면 좁혀질 수 있다.
4. 개발자 질문을 CS 말로 번역해 되돌리는 `willnew ask`: 조사한 어떤 제품에서도 찾지 못했다. Pylon은 이슈 종료 시 대화 상태만 되돌린다. 실재.
5. `willnew work`(브랜치, 티켓 파일, 실패 테스트 초안, Claude Code 실행): Copilot, Devin, Cursor, Claude Code Action이 이슈에서 PR까지를 이미 한다. 에이전트 부분은 선점됨. 차이는 개발자 로컬 터미널과 인수 조건 기반 실패 테스트 초안이라는 흐름에 한정.
6. 로컬 우선(Ollama), 오픈소스, 자체 호스팅: 조사한 상용 제품은 자체 호스팅 옵션을 찾지 못했다. 실재하나 고객 데이터 경계를 중시하는 팀에만 결정 요인. 품질은 로컬 모델 한계에 묶인다.
7. 소규모(10~50명), PM/QA 없음: 비어 있는 포지션이나, 그 규모 팀도 이미 Linear Business나 Jira를 쓸 가능성이 높다.

## 4. 가장 큰 위협과 포지셔닝

위협 순위
1. Linear agent + Zendesk/Intercom 연동(2025-12): 지원 대화 전체를 읽어 이슈를 만든다. 되묻기와 코드 매핑이 붙으면 willnew 가치 일부와 겹친다. Business 이상 플랜이 필요하다는 점이 소규모 팀의 허들.
2. Atlassian Rovo: Jira 플랜에 포함되어 추가 비용이 없고 Bug Report Assistant가 이미 부족한 정보를 요구한다.
3. 채널톡 ALF(한국 시장): 2026-10 AI 에디션 정식 출시. 엔지니어링 티켓 단계로 확장하면 직접 경쟁. 현재 그런 기능의 근거는 확인하지 못했다.
4. Pylon, Plain: B2B 지원 + Linear 양방향. 시트 $89~ 수준이라 10~50명 팀에는 무거울 수 있다.
5. 코딩 에이전트(Copilot, Cursor, Devin, Claude Code Action): 하류 구간. 경쟁보다 연동 대상.

포지셔닝 제안
- 티켓 도구가 아니라 CS와 개발자 사이 번역 계층으로 말한다. 이슈 추적은 Linear/Jira에 맡기고 그 위에 올라탄다.
- 데이터가 밖으로 나가지 않는다는 점과 용어 사전을 팀이 직접 소유한다는 점을 앞세운다. 모델 성능으로 경쟁하지 않는다.
- 대체 대신 기존 도구의 입구(채널톡, Zendesk, Slack)와 출구(Jira, Linear, GitHub)에 붙는다.
- `willnew ask` 역번역과 사전 기반 매핑을 데모 첫 장면에 둔다. 가장 비어 있는 두 자리다.
- 로컬 모델 품질이 낮을 때 클라우드 모델로 바꿀 수 있게 열어 두되 기본은 로컬.

## 5. 연동 우선순위와 API 메모

우선순위 제안: (1) Slack 입구, (2) Jira 또는 Linear 출구 중 팀이 쓰는 쪽 하나, (3) 채널톡 웹훅(한국 시장 차별화), (4) Zendesk.

### 채널톡
- 웹훅 설정은 Channel Desk 설정 > Webhook. 현재 가이드의 이벤트 타입은 Message, UserChat, User. 다른 페이지는 "현재 메시지 생성 이벤트만 지원"이라 적혀 있어 문서 간 차이가 있다. 페이로드 필드는 event(upsert/update/push), type, entity, refers. 서명 검증과 재시도 방식은 열람한 페이지에서 확인하지 못했다(미확인).
- 웹훅 응답에 헤더 `x-quick-reply: true`(선택적으로 `x-bot-name`)를 넣으면 퀵리플라이로 처리된다. https://developers.channel.io/en/categories/Webhook-28bef63d , https://developers.channel.io/docs/what-is-webhook
- Open API는 Channel Desk 설정 > API Key 관리에서 access key와 secret 발급, 과다 호출 시 HTTP 429. 레퍼런스 https://api-doc.channel.io/ 는 api-doc.channel.works 로 리디렉션되고 엔드포인트 목록은 열람하지 못했다. https://developers.channel.io/en/categories/Open-API-060776bd
- 구 Open API/웹훅 페이지는 deprecated 표기. https://developers.channel.io/docs/openapi-webhooks
- ALF 전용 웹훅/API는 개발자 문서에서 확인하지 못했다(미확인). 상담 메시지 웹훅과 Open API로 대화를 받는 구조를 가정하는 것이 안전하다.

### Zendesk
- 웹훅은 사용자/조직 변경용과 티켓 변경용 두 종류이고 트리거나 자동화 조건으로 발화(2차). https://www.eesel.ai/blog/zendesk-webhook-payload-format
- 티켓 생성은 tickets 엔드포인트 POST, 댓글은 티켓 PUT(2차, Braze 가이드 경유).
- Jira 연동은 Jira 웹훅을 관리자가 직접 만들어야 한다(확인). https://support.zendesk.com/hc/en-us/articles/10687180502810-Configuring-a-Jira-Cloud-webhook-for-field-syncing
- 공식 API 레퍼런스(developer.zendesk.com)는 열람하지 못했다. 구현 전 확인 필요.

### Slack
- 비 Marketplace 상용 배포 앱은 conversations.history/replies 가 Tier 1(history는 분당 1회, 한 번에 15개)로 제한됨. Marketplace 앱과 고객이 직접 만든 내부 앱은 영향 없음. 적용일은 문서마다 2025-09-02 또는 2026-03-03으로 다르다. https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
- 팀이 자기 워크스페이스에 직접 앱을 만들어 쓰는 내부 앱 방식이면 제한을 피한다. 배포용 단일 앱 방식은 피한다.
- Socket Mode 처리는 확인하지 못했다(미확인). 자체 호스팅에서 공개 URL 없이 쓸 수 있어 유리할 가능성이 있다.

### Jira
- 이슈 생성 POST /rest/api/3/issue, 대량은 /rest/api/3/issue/bulk(요청당 최대 50개는 2차 인용, 미확인). https://developer.atlassian.com/cloud/jira/platform/rate-limiting
- 2026-03-02부터 Forge, Connect, OAuth 2.0(3LO) 앱에 포인트 기반 속도 제한과 쿼터 적용. API 토큰 기반 트래픽은 기존 burst 제한 유지. 429는 지수 백오프. 같은 문서.
- Jira Cloud 웹훅 문서는 열람하지 못했다(미확인).
- Rovo가 같은 트리거(work item created)에서 에이전트를 돌릴 수 있어, willnew 티켓이 Jira로 들어가면 Rovo 분류와 겹칠 수 있다.

### Linear
- API는 GraphQL 단일 엔드포인트. 웹훅은 Issues, Comments, Projects, Cycles, Users 변경을 푸시하며 생성에 워크스페이스 관리자 권한 필요. 서명 헤더(Linear-Signature, HMAC-SHA256)는 2차 보고만 있고 공식 확인 못함. https://linear.app/docs/api-and-webhooks
- 에이전트 SDK와 Agent Interaction Guidelines가 있으나 세부는 미확인. 호스팅 MCP 서버는 웹훅을 노출하지 않는다는 2차 보고. https://www.scalekit.com/blog/linear-mcp-vs-api

## 6. 확인하지 못한 항목
- Linear, Unthread, Thena, Plain, Freshdesk, Intercom, Zendesk, Devin, Cursor, Marker.io 공식 가격 페이지 직접 열람 실패. 2차 수치는 충돌.
- 채널톡 웹훅 서명 검증, 재시도, API 엔드포인트 상세, 소규모 요금.
- 자체 호스팅 가능 여부: 표의 "클라우드"는 대부분 "자체 호스팅 옵션을 찾지 못함"이지 부재 증명이 아니다.
- Sentry user feedback, Jira Cloud 웹훅, Zendesk 공식 API 문서는 열람하지 못했다.
- 신규 진입자 목록은 검색 한계로 불완전하다.
