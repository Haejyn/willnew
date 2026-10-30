# willnew 가설 근거 조사 (번역 병목, 통역 중심 전환)

조사일 2026-10-30. 표기: [확인] 원문 또는 공식 페이지를 직접 열어 확인한 수치, [2차] 검색 요약이나 블로그 인용만 보고 원문은 못 연 수치, [미확인] 찾지 못함.
판정 표기: 지지 = 번역 병목 가설 또는 전환 방향을 뒷받침, 약화 = 반대 근거 또는 한계, 중립 = 맥락.

## 요약

1. CS에서 개발로 넘어가는 정보 부족이 병목이라는 정량 근거를 직접 측정한 자료는 없다. 가장 가까운 것은 버그 리포트 품질 연구(Bettenburg 등, 2010)와 개발자 시간 손실 설문(Atlassian 2025)이다. 둘 다 "번역 비용"을 직접 재지 않는다.
2. 한국 정량 자료는 이번에도 찾지 못했다(market-research F절과 같은 결론). 프로그래머스, 점핏, SPRi, NIPA 자료에서 CS와 개발 협업 수치를 찾지 못했다.
3. "AI가 고치고 개발자는 승인만 한다" 모델의 위험은 근거가 꽤 있다(리뷰 시간 증가, 신뢰 하락). 다만 대부분 벤더 텔레메트리나 설문이라 인과 근거는 약하다.
4. 작은 작업에서 AI가 잘한다는 근거도 있다(Copilot 대조실험 55.8% 단축, 에이전트 PR 병합률). 선택적 "AI에게 맡기기" 경로를 남기는 판단과 맞는다.
5. 약화 요인: 에스컬레이션의 42%는 복잡한 연동 문제, 25%는 고객이 먼저 찾은 버그(Salesforce 사례). 정보 정리만으로 풀리지 않는 몫이 크다.

## 1. 산업 설문과 보고서

### 1-1. Atlassian State of Developer Experience 2025 [확인]
- 표본: 개발자와 매니저 3,500명, 6개국.
- 수치: 50%가 주당 10시간 이상, 90%가 6시간 이상을 잃음(주로 조직 비효율). 개발자가 코딩에 쓰는 시간은 16%. 시간 낭비 상위는 정보 찾기, 새 기술 적응, 도구 간 맥락 전환이고 팀 간 협업이 순위 상승. AI로 주 10시간 이상 절약한다는 응답 68%.
- 링크: https://www.atlassian.com/blog/developer/developer-experience-report-2025
- 판정: 지지(코딩 외 시간이 병목, 팀 간 협업 상승). 한계: CS에서 개발로의 번역을 따로 재지 않음.
- 2차 보도: https://www.itpro.com/software/development/atlassian-says-ai-has-created-an-unexpected-paradox-for-software-developers-theyre-saving-over-10-hours-a-week-but-theyre-still-overworked-and-losing-an-equal-amount-of-time-due-to-organizational-inefficiencies
- 2024판 [2차]: 엔지니어링 리더 1,250명(미국, 독일, 프랑스, 호주)과 개발자 900명. 팀 간 협업이 역할 복잡성 상위 5개 원인 중 하나. https://atlassian.com/ko/team-playbook/plays/devex-survey (검색 요약만 확인)

### 1-2. Stack Overflow Developer Survey 2025 [확인]
- 표본: AI 정확도 신뢰 문항 응답 33,244건(전체 응답자 수는 페이지에 명시 없음).
- 수치: AI 출력 정확도를 신뢰 32.7%(매우 3.1%, 어느 정도 29.6%), 불신 45.7%. "거의 맞지만 완전히는 아닌 AI 해답"이 불만 1위 66%(응답 31,476건). "AI 코드 디버깅이 더 오래 걸림" 45.2%. AI 에이전트를 업무에 어떤 빈도로든 쓰는 비율 30.9%, 매일 14.1%.
- 링크: https://survey.stackoverflow.co/2025/ai
- 판정: 지지(승인만 하는 모델은 거의 맞는 코드를 검수하는 부담이 큼, 신뢰 낮음). 한계: 설문 자기보고.
- 2024판 [2차]: 응답자 60% 이상이 하루 30분 이상 해답 찾는 데 쓰고 53%가 답 기다림이 흐름을 끊는다고 응답. https://stackoverflow.co/teams/resources/your-developers-deserve-better-insights-from-the-2024-developer-survey

### 1-3. DORA 2025 State of AI-assisted Software Development [일부 확인]
- 확인: 공식 페이지 문구 "AI의 주된 역할은 증폭기, 조직의 강점과 약점을 키운다". https://dora.dev/research/2025/dora-report/
- 2차: 약 5,000명 조사, 90%가 업무에 AI 사용, 하루 중앙값 2시간. 처리량 개선, 불안정성과 리워크의 정확한 수치는 못 확인. https://www.techrepublic.com/article/news-dora-ai-report-2025/ , https://blog.google/technology/developers/dora-report-2025/
- 판정: 중립에서 지지. "AI는 기존 협업의 허점을 키운다"는 해석은 번역 문제를 먼저 풀어야 한다는 논리와 맞지만 직접 근거는 아님. 원문 PDF 미확인.

### 1-4. METR 개발자 생산성 RCT [확인]
- 2025-07: 숙련 오픈소스 개발자 16명, 실제 이슈 246건(평균 약 2시간), AI 허용 시 19% 더 오래 걸림(95% CI +2%~+39%). 개발자는 24% 단축을 예상했고 연구 후에도 20% 빨라졌다고 믿음. 도구는 Cursor Pro와 Claude 3.5/3.7 Sonnet. 링크: https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
- 2026-02 업데이트: 후속 연구 57명, 저장소 143개, 작업 800건 이상. 기존 참가자 -18%(CI -38%~+9%), 신규 -4%(CI -15%~+9%). 참가자의 30~50%가 AI 없이 하기 싫은 작업을 숨김. METR 스스로 신뢰하기 어렵고 실제 단축은 더 클 수 있다고 밝힘. 링크: https://metr.org/blog/2026-02-24-uplift-update/
- 판정: 지지와 약화가 섞임. 사람이 AI 결과를 정리하고 검수하는 시간이 이득을 상쇄할 수 있다는 근거(지지)이나, 후속 연구가 신뢰 불가라고 스스로 밝혀 "AI 생산성이 낮다"로 단정 인용하면 안 됨. 2025 결과를 쓸 때는 "초기 도구, 소수 숙련자, 익숙한 대형 저장소" 조건을 붙인다. 일부 블로그가 "METR가 결과를 뒤집었다"고 쓰지만 METR 원문은 새 단축 수치를 내지 않음.
- 에이전트 과제 길이 [2차]: 50% 성공 기준 과제 길이가 약 7개월마다 2배(2019~2025), 2023년 이후 약 4.3개월. 80% 신뢰 기준은 훨씬 짧음(Claude 3.7 Sonnet 50%에서 59분, 80%에서 15분). https://arxiv.org/pdf/2505.05115 (검색 요약만)

### 1-5. Faros AI "AI Productivity Paradox" 2025 [확인, 벤더 텔레메트리]
- 표본: 개발자 10,000명 이상, 팀 1,255개.
- 수치: AI 도입이 높은 팀은 작업 21% 더 완료, PR 98% 더 병합, PR 리뷰 시간 91% 증가, 평균 PR 크기 154% 증가, 개발자당 버그 9% 증가. 회사 수준 성과 개선과의 유의한 상관은 없음.
- 링크: https://www.faros.ai/blog/ai-software-engineering
- 판정: 지지("승인만" 모델은 리뷰가 병목이 됨). 한계: 상관이고 벤더 자료.

### 1-6. CodeRabbit State of AI vs Human Code Generation 2025-12 [2차, 벤더]
- 표본: 오픈소스 PR 470건(AI 공동 작성 320, 사람 150). PR당 지적 사항 AI 10.83 대 사람 6.45(약 1.7배).
- 링크: https://www.businesswire.com/news/home/20251217666881/en/CodeRabbits-State-of-AI-vs-Human-Code-Generation-Report
- 판정: 지지(리뷰 부담). 한계: 보고서 원문은 가입 필요, 사람 작성 PR 분류의 정확성 한계를 제작사가 인정.

### 1-7. Zendesk CX Trends 2026 [2차]
- 표본: 소비자 6,182명, 기업 응답 5,115명(2025-06 조사). 고객 74%가 정보를 반복해야 할 때 불만, 81%가 대화를 이어받는 응대를 원함. Five9 2026 조사(3,000명, 미국 영국 독일)는 이관 후 반복 설명을 겪는다는 응답 83%.
- 링크: https://s3.amazonaws.com/external_clips/5181339/Zendesk_CX_trends_report_2026.pdf (원문 PDF를 열지 못함, 블로그 인용만 확인)
- 판정: 지지(맥락 단절이 흔함). 한계: 고객 대 상담원 이관이며 CS 대 개발이 아님.
- Gartner, Forrester, Intercom의 CS에서 엔지니어링 에스컬레이션 수치: [미확인]. GitHub Octoverse의 리뷰 부담 수치도 [미확인].

## 2. CS에서 엔지니어링으로의 에스컬레이션

### 2-1. Bettenburg 등, "What Makes a Good Bug Report?" [2차 확인, 원문 PDF는 텍스트 추출 실패]
- 표본: 개발자 156명(2007 기술보고서), 제보자 310명 추가, 합계 466명(TSE 2010). Apache, Eclipse, Mozilla.
- 결과: 개발자가 가장 원하는 것은 재현 단계, 스택 트레이스, 테스트 케이스. 가장 큰 장애는 부정확한 재현 단계와 불완전한 정보. 개발자가 필요한 정보와 제보자가 주는 정보가 어긋나고, 가장 필요한 항목이 제보자에게 가장 제공하기 어렵다. Eclipse 논문에서는 재현 단계를 47명 중 42명이 가장 중요한 항목에 꼽음. CUEZILLA 품질 예측기는 289건으로 학습해 31~48%만 정확히 예측.
- 링크: https://thomas-zimmermann.com/publications/files/zimmermann-tse-2010.pdf , https://www.st.cs.uni-saarland.de/publications/files/bettenburg-tr-2007.pdf
- 판정: 강하게 지지(번역 병목의 학술적 뿌리, 재현 단계가 핵심 항목, 준비 완료 기준 검사 아이디어의 근거). 한계: 오픈소스 개발자와 최종 사용자 대상, 2007~2010년 자료, CS 중간층 없음.

### 2-2. Salesforce Engineering 사례 [확인, 표본과 방법 미공개]
- 수치: 에스컬레이션의 약 33%는 고객지원이 해결했어야 할 문제, 25%는 내부 테스트보다 고객이 먼저 찾은 버그, 42%는 복잡한 연동 문제. 자동 의사결정 LAP 처리 48시간에서 10분 미만(99.7% 개선), 로그 수집은 며칠에서 몇 분.
- 링크: https://engineering.salesforce.com/how-ai-tools-cut-customer-escalation-time-from-days-of-manual-work-to-minutes/
- 판정: 양쪽. 33%가 지원 단계에서 풀릴 몫이라는 점은 지지(정리와 가이드가 효과 있음), 42%가 복잡한 연동이라는 점은 약화(정리만으로 안 풀림). 한계: 표본, 기간, 방법 없음, 여러 자동화가 동시 진행.

### 2-3. 에스컬레이션 비율과 비용 [2차, 벤더 블로그 수준, 인용 비권장]
- 15~30%가 엔지니어링으로 간다는 벤더 블로그, 엔지니어링 에스컬레이션이 L1 해결보다 비용 8배, 시간 5배라는 벤더 주장. 출처 불명.
- 링크: https://stealthagents.com/research/customer-support-ticket-escalation-rate-statistics-2026 , https://www.zipchat.ai/blog/how-to-reduce-engineering-escalations
- TSIA 토론: 지원 티켓 중 엔지니어링 티켓이 되는 비율에 공유된 벤치마크 없음. https://discussions.tsia.com/discussion/491/
- 판정: 사용 불가에 가까움. "재현 불가 비율", "왕복 횟수당 비용"은 공개 연구를 찾지 못함 [미확인].

## 3. 한국 자료

- 정량 자료 [미확인]: 채널톡, 토스, 우아한형제들, 카카오, 당근, 라인, 쏘카 기술 블로그, SPRi, NIPA, 프로그래머스, 점핏 중 CS와 개발 협업 수치를 담은 것을 찾지 못함. SPRi 근로환경 조사는 주당 평균 근로시간 약 41.27시간만 확인(회의, 협업 비용 없음) [2차]. https://spri.kr/post/23271
- 정성 [2차]:
  - 당근 운영 개발팀이 접수 VoC를 자체 운영툴로 자동 분류하고 데이터 분석에 쓴다는 인터뷰. 수치 없음. https://channel.io/kr/blog/articles/interview-daangnservice-6d58e831
  - 왓챠 사례: 개발자와 CS팀이 반복 업무를 코드로 자동화하고 관리자 기능을 개선해 CS 업무량을 줄임. 페이지가 403이라 제목과 검색 요약만 확인, 수치 미확인. https://www.theteams.kr/teams/2849/post/73229
  - 위키독스 "안 돼요는 요청문이 아니다": 모호한 제보를 그대로 넘기면 추측성 수정이 돌아온다는 주장. 개인 글. https://wikidocs.net/425957
  - 위키독스 버그 리포트 템플릿: 환경, 재현 순서, 기대와 실제 결과, 빈도, 로그 항목. https://wikidocs.net/367643
  - 채용 공고에 "CS/영업팀과 개발팀 사이의 기술적 중재", "재현 안 됨 결론 전에 고객 환경 시뮬레이션" 요구가 있음(수요 신호, 통계 아님). https://demoday.co.kr/recruits/8857
- 판정: 한국 정량 근거는 없다고 문서에 그대로 적는 것이 안전하다. 해외 연구를 인용하고 한국 도입 파일럿에서 직접 재는 것이 맞다.

## 4. "AI가 고치고 승인만" 모델의 문제 대 소규모 위임 근거

문제를 보여 주는 근거(전환 지지): 1-2의 불신 45.7%와 "거의 맞음" 66%, 디버깅 45.2%. 1-5의 리뷰 시간 91% 증가. 1-6의 지적 사항 1.7배. 1-4의 2025 결과(제한 조건 포함). 책임과 승인 피로를 직접 다룬 정량 연구는 [미확인].

소규모 위임 근거(선택 경로 유지 지지):
- GitHub Copilot 대조실험(Peng 등, 2023, arXiv 2302.06590) [확인]: JavaScript HTTP 서버 구현 과제에서 Copilot 사용군이 55.8% 더 빠르게 완료. 참가자 수와 신뢰구간은 초록 페이지에 없어 [미확인]. https://arxiv.org/abs/2302.06590
- 에이전트 PR 병합률 [2차]: 33,000건 규모 연구에서 전체 병합률 71.48%, 문서 84%, CI 79%, 빌드 74%, 성능 55%, 버그 수정 64%. Copilot 43.04%, Codex 82.59%. 검색 결과로 보아 arXiv 2601.15195 계열(https://www.alphaxiv.org/abs/2601.15195)로 보이나 정확한 대응은 확인 못 함.
- METR 과제 길이 추세(1-4): 짧은 과제의 신뢰도가 긴 과제보다 높음.
- 판정: 작고 명확한 작업은 위임 가능하다는 방향은 지지. 단 병합률은 "에이전트가 올린 PR 중 병합된 것"이라 선택 편향이 있고, 버그 수정 병합률은 64%로 낮음.

## 5. 피드백 루프 닫기

- 21% 수치 [2차, 방법 불명]: 루프를 닫은 고객이 다음 설문에 응답할 가능성 21% 상승. 한 사례는 응답률 13% 대 업계 평균 5%. 대조 실험이 아니고 벤더 글. https://customergauge.com/blog/cx-storm-series-part-4 , https://martech.org/why-closing-the-feedback-loop-drives-better-cx-outcomes/
- Forrester "VoC 프로그램 중 공식 루프 닫기 절차는 40% 미만"은 1차 출처 없이 인용됨 [미확인].
- 개발 제보자(내부 CS 포함)에 대한 연구 [미확인].
- 판정: 방향은 지지하나 근거 수준이 낮다. 제품 문서에서 정량 주장으로 쓰지 말고 가설로 적고, 파일럿에서 제보 재작성률, 재문의율 등을 직접 측정하는 편이 낫다.

## 6. 문서에 쓸 때의 제안

- 인용 가능(확인됨): Atlassian 2025(3,500명, 16%, 50%와 90%), Stack Overflow 2025(33,244건, 45.7% 불신, 66%, 45.2%), METR 2025와 2026 업데이트(둘 다 한계 명시), Faros(10,000명, 1,255팀, 91%), Salesforce 33/25/42(방법 없음 명기), Peng 2023(55.8%).
- 조건부: Bettenburg(466명), CodeRabbit(470 PR), Zendesk(6,182명과 5,115명)는 원문 재확인 후.
- 쓰지 말 것: 벤더 블로그의 에스컬레이션율과 8배 비용, "21% 더 응답" 같은 출처 불명 수치.
- 가설 약화 요인을 함께 적는다: 에스컬레이션 42%는 복잡 연동, 25%는 고객이 먼저 발견한 버그. 통역은 필요조건이지 충분조건이 아니다.
- 직접 측정 제안: 재현 단계 누락 비율, 개발자 되묻기 횟수, 티켓 재오픈율, 접수에서 첫 착수까지 시간을 파일럿 전후로 잰다. 공개 수치가 없으므로 이것이 가장 강한 근거가 된다.
