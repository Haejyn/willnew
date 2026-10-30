# 인용 검증 보고서 (market-research.md 섹션 A, B)

작성일: 2026-10-30
검증 방법: 원문 PDF를 직접 열어 확인한 항목은 "원문 확인", 초록이나 검색 요약만 본 항목은 "초록 수준"으로 표시했다.
원문 확인: Bettenburg FSE 2008, Bettenburg ICSM 2008, Zimmermann ICSE 2012, BURT ICSE 2023 시연 논문(arXiv).
초록 수준: Runeson ICSE 2007, ChatBR, BURT FSE 2022.

## 1. 판정 요약

| # | 항목 | 판정 | 문제 |
|---|---|---|---|
| 1 | Bettenburg 외 FSE 2008 | 정확 | 없음 |
| 2 | CUEZILLA | 일부 틀림 | 후속 도구가 아니라 같은 FSE 2008 논문 안의 프로토타입. 정확도 31~48% |
| 3 | Runeson 외 ICSE 2007 | 일부 틀림 | 서지는 맞음. "16~40% 중복" 수치는 확인 불가 |
| 4 | Bettenburg 외 ICSM 2008 | 일부 틀림 | 서지는 맞음. 본문 A.2에서 "Zimmermann 외(2010)"로 잘못 적음 |
| 5 | Zimmermann 외 ICSE 2012 | 일부 틀림 | "6~10% 재오픈"은 이 논문에 없음 |
| 6 | BURT (FSE 2022, ICSE 2023) | 일부 틀림 | ICSE 2023은 도구 시연 논문. 양식을 모든 면에서 앞선 것은 아님. LLM 기반 아님 |
| 7 | ChatBR ASE 2024 | 일부 틀림 | 되묻는 도구가 아니라 빠진 항목을 ChatGPT가 생성해 채우는 도구 |

## 2. 항목별 상세

### 2.1 Bettenburg 외, "What Makes a Good Bug Report?" (정확, 원문 확인)

- 저자: Nicolas Bettenburg, Sascha Just, Adrian Schröter, Cathrin Weiss, Rahul Premraj, Thomas Zimmermann
- 학회: ACM SIGSOFT FSE 2008, pp. 308-318. DOI 10.1145/1453101.1453146
- 원문 확인 내용
  - 개발자 872명에게 설문을 보내 156명이 응답, 제보자 1,354명 중 310명이 응답. 합계 466 응답.
  - 초록: "Most developers consider steps to reproduce, stack traces, and test cases as helpful, which are at the same time most difficult to provide for users."
  - 개발자 표(Table 2): 재현 단계 중요도 83%, 스택 트레이스 57%, 테스트 케이스 51%. 문제 항목에서 재현 단계 오류 79%, 불완전한 정보 74%.
  - 본문: "The most severe problems were errors in steps to reproduce and incomplete information."
- 문서의 "정확히 겹친다", "부정확·불완전한 재현 단계가 가장 큰 장애물"은 위 문장과 일치한다.
- 권장 문장: "Bettenburg 외(FSE 2008)가 Apache, Eclipse, Mozilla의 개발자와 제보자 466명에게 설문한 결과, 개발자가 도움이 된다고 본 재현 단계, 스택 트레이스, 테스트 케이스는 제보자가 제공하기 가장 어려운 정보와 같았다. 개발자는 재현 단계 오류와 불완전한 정보를 가장 심각한 문제로 꼽았다."

### 2.2 CUEZILLA (일부 틀림, 원문 확인)

- 문서는 "위 논문의 후속 도구"라고 썼으나, CUEZILLA는 같은 FSE 2008 논문에서 소개된 프로토타입이다.
- 문서에 정확도가 빠져 있다. 논문은 개발자가 평가한 289개 리포트로 학습했고, 품질을 31~48% 정확하게 예측했다고 쓴다. 낮은 수치라서 "원형" 이라고만 말하면 반문을 받을 수 있다.
- 논문의 Figure 1은 UI 목업이다. 실제 배포 검증은 아니다.
- 권장 문장: "같은 논문의 CUEZILLA 프로토타입은 리포트 품질을 측정하고 추가할 항목을 권고한다. 289개 리포트로 학습해 품질 예측 정확도는 31~48%였다."

### 2.3 Runeson, Alexandersson, Nyholm (일부 틀림, 초록 수준)

- 제목: Detection of Duplicate Defect Reports Using Natural Language Processing
- 학회: ICSE 2007, pp. 499-508. DOI 10.1109/ICSE.2007.32 (https://lup.lub.lu.se/record/643449 기준)
- 확인한 내용: Sony Ericsson Mobile Communications의 결함 보고서 대상. 초록은 "about 2/3 of the duplicates can possibly be found using the NLP techniques"라고 쓴다. 중복 중 약 3분의 2를 찾을 가능성이 있다는 뜻이며 전체 리포트 중 중복 비율이 아니다.
- 확인 불가: "전체 버그 리포트의 16~40%가 중복". 초록과 검색 결과에서 찾지 못했고, 이 논문의 원문 PDF는 열지 못했다. 이대로 인용하면 안 된다.
- 2차 자료(확정 아님): Borg 외 후속 복제 연구 발표 자료가 원 논문을 "thousands of reports, 10% duplicates, 40% of true duplicates found"로 요약한다. 원문 확인 전에는 쓰지 않는다.
- 대신 쓸 수 있는 원문 확인 수치: Bettenburg 외(ICSM 2008) 서론이 Anvik 외를 인용해 "Mozilla 약 30%, Eclipse 약 20%가 중복"이라고 쓴다.
- 권장 문장: "Runeson 외(ICSE 2007)는 Sony Ericsson 사례에서 자연어 처리로 중복의 약 3분의 2를 찾을 수 있다고 보고했다. 중복 비율은 Anvik 외를 인용한 Bettenburg 외(ICSM 2008) 기준으로 Mozilla 약 30%, Eclipse 약 20%다."

### 2.4 Bettenburg, Premraj, Zimmermann, Kim, ICSM 2008 (일부 틀림, 원문 확인)

- 제목: Duplicate Bug Reports Considered Harmful ... Really?
- 학회: IEEE ICSM 2008, pp. 337-345. 2018년 ICSME에서 Most Influential Paper 상 수상(HKUST 소식 기준).
- 초록 원문 요지: 설문에서 대부분의 개발자가 중복을 경험했으나 심각한 문제로 본 사람은 적었고, 중복이 주는 추가 정보가 해결을 빠르게 돕는다고 답했다. 저자들은 중복을 따로 두지 말고 병합하자고 제안하고, 추가되는 정보의 양을 정량화하며, 자동 분류도 개선됨을 보인다.
- 틀린 점: 문서 A.2는 "Zimmermann 외(2010)"라고 적었다. 제1저자는 Bettenburg이고 연도는 2008이다.
- 과장 가능 지점: 문서는 "추가 재현 경로와 환경 정보"라고 썼다. 원문에서 측정한 정보는 제품, 버전, OS, 하드웨어, 첨부, 스크린샷, 스택 트레이스, 코드 등이다. "재현 경로" 자체의 수치는 확인하지 못했다.
- 권장 문장: "Bettenburg 외(ICSM 2008)의 설문에서 대부분의 개발자가 중복 리포트를 경험했으나 심각한 문제로 본 사람은 적었고, 중복 리포트가 추가 정보를 준다고 답했다. 저자들은 중복을 버리지 말고 병합하자고 제안한다."

### 2.5 Zimmermann, Nagappan, Guo, Murphy, ICSE 2012 (일부 틀림, 원문 확인)

- 제목: Characterizing and Predicting Which Bugs Get Reopened
- 학회: ICSE 2012 (SEIP 트랙). Microsoft Windows 사례, 358명 설문.
- 틀린 점: "해결된 버그의 6~10%가 다시 열린다"는 이 논문에서 찾지 못했다. 원문 전체를 텍스트로 추출해 확인했는데, 재오픈 비율은 Windows Vista(P)와 Windows 7(Q)의 "익명화된 기준 비율"로만 쓰이고 절대 수치가 없다. 358명 설문은 맞다.
- "6~10%"의 출처 추정: 후속 논문(Tagra 외)이 Mi와 Keung(2016)이 Eclipse 계열 4개 프로젝트에서 6~10%를 관찰했다고 쓴 것을 검색 요약에서 봤다. 2차 인용이라 원문 확인이 필요하다.
- 문서의 "불충분한 초기 정보와 조직·소통 요인"에서 "불충분한 초기 정보"는 직접 근거를 찾지 못했다. 논문이 다루는 요인은 개발자 평판, 지리적, 조직적 거리, 버그 발견 방식 등이다.
- 권장 문장: "Zimmermann 외(ICSE 2012)는 Microsoft 엔지니어 358명 설문과 Windows 버그 데이터로 재오픈 원인을 분석했다. 재오픈 비율의 절대 수치는 논문에 공개되어 있지 않다." G3 지표 근거로는 이 문장까지만 쓴다.

### 2.6 BURT (일부 틀림)

- FSE 2022: Yang Song, Junayed Mahmud, Ying Zhou, Oscar Chaparro, Kevin Moran, Andrian Marcus, Denys Poshyvanyk, "Toward Interactive Bug Reporting for (Android App) End-Users", ESEC/FSE 2022. arXiv 2209.10062. 초록 수준, 원문 미확인.
- ICSE 2023: Song, Mahmud, Nadeeshan De Silva, Zhou, Chaparro, Moran, Marcus, Poshyvanyk, "BURT: A Chatbot for Interactive Bug Reporting", ICSE 2023 Demonstrations. arXiv 2302.06050. 원문 확인. 문서의 저자 목록에는 De Silva가 빠져 있다.
- 틀린 점 1: ICSE 2023 논문은 연구 논문이 아니라 도구 시연이다.
- 틀린 점 2: BURT는 LLM 챗봇이 아니다. 자연어 처리, 동적 분석, 자동 품질 평가 기법을 쓰고 실행 모델에서 화면과 재현 단계를 제안하는 Android 전용 웹 도구다.
- 틀린 점 3: 문서는 "정적 양식보다 리포트 품질을 높임을 보였다"고 썼다. ICSE 시연 논문의 평가는 18명, 앱 6개의 버그 12개, 템플릿 기반 웹 양식 ITRAC과 비교한 리포트 108개다.
  - 재현 단계(S2R): BURT가 낫다. 잘못된 S2R 8.3% 대 20.4%, 빠진 S2R 19.4% 대 32%.
  - 기대 동작(EB): 비슷하다. 잘못된 기술 8건 대 6건(54건 중).
  - 관찰 동작(OB): BURT가 더 나쁘다. 잘못된 기술 16건 대 8건(54건 중). 저자들도 개선이 필요하다고 쓴다.
- 권장 문장: "BURT(ESEC/FSE 2022, ICSE 2023 시연)는 Android 최종 사용자에게 관찰 동작, 기대 동작, 재현 단계를 대화형으로 묻는 도구다. 18명 평가에서 템플릿 양식보다 재현 단계의 오류와 누락은 적었지만, 관찰 동작은 더 부정확했다."

### 2.7 ChatBR (일부 틀림, 초록 수준)

- 서지: Lili Bo, Wangjie Ji, Xiaobing Sun, Ting Zhang, Xiaoxue Wu, Ying Wei, "ChatBR: Automated Assessment and Improvement of Bug Report Quality Using ChatGPT", ASE 2024, pp. 1472-1483. https://conf.researchr.org/details/ase-2024/ase-2024-research/118/ (DOI는 확인하지 못함)
- 확인한 내용: 미세조정한 BERT가 관찰 동작, 기대 동작, 재현 단계 중 빠진 항목을 판별하고, ChatGPT가 zero-shot으로 빠진 내용을 생성한다. 누락 탐지 정밀도가 기존 방법보다 25.38~29.20% 높고, 생성 정보의 의미 유사도는 6개 프로젝트 평균 84.10%.
- 틀린 점: 문서 A.4는 "챗봇이 ... 되묻는" 방식에 ChatBR를 넣었다. ChatBR는 제보자에게 되묻지 않고 LLM이 내용을 채운다. 되묻기의 근거가 아니라 생성 보강의 근거다. 문서의 "반복 루프", "문장별 판별"은 확인하지 못했다.
- 주의: LLM이 채운 내용은 제보자가 말하지 않은 사실을 만들 수 있다. willnew가 생성 대신 근거 있는 되묻기를 택한 이유로 쓸 수 있다.
- 권장 문장: "ChatBR(ASE 2024)는 BERT로 버그 리포트의 관찰 동작, 기대 동작, 재현 단계 누락을 찾고 ChatGPT로 빠진 내용을 생성한다. 사용자에게 되묻는 방식은 아니다."

## 3. 문서 본문에서 같이 고칠 곳

- A.2: "Zimmermann 외(2010)"를 "Bettenburg 외(ICSM 2008)"로 바꾼다.
- A.2: "16~40%", "6~10%" 두 수치는 위 근거로 교체하거나 삭제한다.
- A.4와 B표 #6, #7: "BURT, ChatBR은 정적 양식보다 품질을 높임"을 "BURT는 템플릿 대비 재현 단계 품질이 높았고 관찰 동작은 낮았다. ChatBR는 누락 항목을 LLM으로 생성한다"로 바꾼다.
- B표 #2: "후속 도구"를 삭제한다.
- B표 #6: ICSE 2023은 도구 시연이라고 적는다.

## 4. 추가 논문 (2023~2026)

열람 수준을 항목마다 표시했다.

1. ClarifyGPT (arXiv 초록과 FSE 2024 페이지)
   - Fangwen Mu, Lin Shi, Song Wang, Zhuohao Yu, Binquan Zhang, Chenxue Wang, Shichao Liu, Qing Wang, "ClarifyGPT: A Framework for Enhancing LLM-based Code Generation via Requirements Clarification", Proc. ACM on Software Engineering (FSE 2024). DOI 10.1145/3660810. https://arxiv.org/abs/2310.10996
   - 발견: 코드 일관성 검사로 요구사항이 모호한지 판단하고, 모호할 때만 질문을 만든다. MBPP-sanitized에서 GPT-4 Pass@1이 70.96%에서 80.80%로 올랐다(참가자 10명). 자동 평가는 사용자 응답을 시뮬레이션했다.
   - willnew 연결: "언제 물을지와 무엇을 물을지를 나누는" 설계를 지지한다. 한계는 코드 생성 벤치마크이고 CS 제보가 아니라는 점.

2. Active Task Disambiguation with LLMs (초록 수준)
   - ICLR 2025, arXiv 2502.04485. 저자 목록은 확인하지 못했다.
   - 발견: 제로샷으로 LLM이 만든 질문은, 후보 해답에 대한 정보량으로 고른 질문보다 효율이 낮다.
   - willnew 연결: 질문을 LLM 재량에만 맡기면 품질이 떨어질 수 있다는 점에서 필수 칸 기반 규칙과 같이 쓰는 설계를 지지한다. 동시에 순수 LLM 되묻기에 대한 도전이다.

3. AdbGPT (arXiv 초록 요약)
   - Sidong Feng, Chunyang Chen, "Prompting Is All You Need: Automated Android Bug Replay with Large Language Models", ICSE 2024. arXiv 2306.01987.
   - 발견: 버그 리포트에서 재현 단계를 추출하고 GUI 이벤트에 맞춰 재생해 리포트의 81.3%를 재현했다(평균 253.6초). 실제 리포트 5건으로 소규모 사용자 연구.
   - willnew 연결: 구조화된 재현 단계에서 자동 재현으로 이어지는 마지막 구간(`willnew work`)의 선례. Android GUI 한정이라는 범위 제한이 있다.

4. Acharya, Ginde (초록 수준)
   - "Can We Enhance Bug Report Quality Using LLMs?: An Empirical Study of LLM-Based Bug Report Generation", EASE 2025. arXiv 2504.18804.
   - 발견: 미세조정한 Qwen 2.5가 CTQRS 77%, ChatGPT-4o 3-shot 75%. 재현 단계 항목 F1 76%. 미지 프로젝트(Eclipse, GCC)에서 최대 70%.
   - willnew 연결: 비정형 제보를 표준 템플릿으로 바꾸는 일을 작은 오픈 모델로 할 수 있다는 근거(로컬 Ollama 설계). 지표가 텍스트 유사도 중심이라 사실 정확성은 따로 검증해야 한다.

5. Quattrocchi 외 (초록 수준)
   - "Can LLMs Generate User Stories and Assess Their Quality?", arXiv 2507.15157 (2025). 학회명은 확인하지 못했다.
   - 발견: LLM 10종이 분석가와 고객을 모두 연기하는 인터뷰로 약 14,000개 사용자 스토리를 만들었다. 품질은 사람이 쓴 것과 비슷하지만 수용 기준 충족 비율은 낮았다.
   - willnew 연결: 수용 기준 초안 자동 생성이 약점일 수 있다는 근거. 사람 확인 단계가 필요한 이유.

6. Bashir 외 (초록 수준, 연도 미확인)
   - "Requirements Ambiguity Detection and Explanation with LLMs: An Industrial Study" (https://www.es.mdu.se/publications/7221-Requirements_Ambiguity_Detection_and_Explanation_with_LLMs__An_Industrial_Study). 저자 전체와 학회는 확인하지 못했다.
   - 발견: 실제 산업 요구사항에서 LLM의 모호성 탐지와 설명을 in-context learning으로 평가하고 전문가 8명이 평가했다. 수치는 확인하지 못했다.
   - willnew 연결: 모호함 탐지를 LLM에 맡기는 설계의 산업 사례. 수치를 확인하기 전에는 인용하지 않는다.

7. NaPiRE (arXiv 초록, 기간은 2023 이전)
   - Méndez Fernández 외, "Naming the Pain in Requirements Engineering: Contemporary Problems, Causes, and Effects in Practice", Empirical Software Engineering, 2016. arXiv 1611.10288.
   - 발견: 10개국 228개 회사 설문으로 요구공학 문제의 원인과 결과를 분석했다. 검색 요약에는 고객과 팀 사이 소통 문제가 상위 문제이고 불완전, 숨은 요구사항이 재작업으로 이어진다는 서술이 있으나 본문에서 직접 확인하지 못했다.
   - willnew 연결: 소통 불일치 비용의 근거 후보. 재작업 비용 금액은 확인하지 못했다. 2016년이라 요청 기간 밖이다.

8. Tam 외 (초록 수준)
   - Derek Tam, Anisha Mascarenhas, Shiyue Zhang, Sarah Kwan, Mohit Bansal, Colin Raffel, "Evaluating the Factual Consistency of Large Language Models Through News Summarization", Findings of ACL 2023, pp. 5220-5255. arXiv 2211.08412.
   - 발견: 23개 LLM(1B~176B)이 대체로 사실과 일치하는 요약에 더 높은 점수를 준다. 단 사실과 맞지 않는 요약이 원문 문장을 그대로 담고 있으면 오히려 더 높은 점수를 주는 경향이 있다.
   - willnew 연결: 요약 충실도를 LLM 자체 평가로 검증하는 설계의 한계. 원문 인용이 붙어 있다고 정확한 것은 아니다.

9. Ji 외 (초록 수준)
   - "Survey of Hallucination in Natural Language Generation", ACM Computing Surveys 55(12), 2023, pp. 1-38. DOI 10.1145/3571730. arXiv 2202.03629.
   - 발견: 요약, 대화, 질의응답 등에서 환각의 정의, 측정, 완화를 정리한 서베이.
   - willnew 연결: "근거 없는 내용을 티켓에 쓰지 않는다"는 원칙의 일반 배경. 새 실험이 아니라 개관이다.

찾지 못한 영역: 소프트웨어 팀의 오해로 생긴 재작업 비용을 정량화한 2023~2026 동료심사 논문은 이번 검색에서 신뢰할 만한 것을 못 찾았다. "결함을 늦게 고칠수록 비용이 100배" 류 주장은 출처가 약한 것으로 알려져 있으니 쓰지 않는 편이 안전하다(이 문장은 기억에 근거하므로 확인이 필요하다).

## 5. willnew 접근에 반하는 근거

1. GitHub 이슈 템플릿 연구 (초록 수준)
   - Emre Sülün, Metehan Saçakçı, Eray Tüzün, "An Empirical Analysis of Issue Templates Usage in Large-Scale Projects on GitHub", ACM TOSEM 33(5), 2024. DOI 10.1145/3643673.
   - 내용: 100개 대형 프로젝트의 템플릿 350개와 이슈 190만 건 이상을 분석하고 유지관리자를 설문했다. 템플릿이 있는 프로젝트가 해결이 빠르고 댓글이 적었다. 구조화된 YAML 템플릿은 해결 시간, 재오픈, 논의 길이의 추가 감소와 연관됐다. 검색 요약은 평균 해결 시간을 약 381일에서 103일로 적었으나 직접 확인하지 못했다.
   - 해석: 상관 관찰 연구이고 인과를 증명하지 않는다. 대상은 개발자가 직접 쓰는 오픈소스 이슈라서, 비개발자 CS가 고객 말을 전하는 상황과 다르다. 그래도 "템플릿이면 충분하지 않나"(C21)에 대한 가장 좋은 학술 반론 근거다. TSE 2022의 Li 외 연구는 방향이 다른 결과를 보고한 것으로 보이나 스니펫만 봤다.

2. Bucinca, Malaya, Gajos, "To Trust or to Think: Cognitive Forcing Functions Can Reduce Overreliance on AI in AI-assisted Decision-making", CSCW 2021 (초록 수준). arXiv 2102.09692.
   - 내용: AI 보조 의사결정에서 사람이 틀린 AI 제안도 따르는 과의존이 나타나고, 설명을 붙여도 줄지 않거나 늘 수 있다. 강제 사고 장치(체크리스트 등)는 과의존을 줄이지만 주관 평가는 낮았고, 인지 욕구가 높은 사람이 더 혜택을 봤다(참가자 199명).
   - 해석: 챗봇 중개가 이해를 줄인다는 직접 연구가 아니라 의사결정 보조 연구다. CS가 AI 요약을 그대로 승인할 위험, 개발자 답변 통역을 그대로 믿을 위험을 설명할 때 쓸 수 있다.

3. Laban, Hayashi, Zhou, Neville, "LLMs Get Lost In Multi-Turn Conversation", arXiv 2505.06120 (2025) (초록 수준)
   - 내용: 6개 생성 과제, 20만 건 이상 시뮬레이션 대화에서 LLM의 다중 턴 성능이 단일 턴보다 평균 39% 낮았다. 능력 저하보다 신뢰성 저하가 크고, 모델이 초기에 가정을 세우고 거기에 의존해 잘못된 방향에서 회복하지 못한다.
   - 해석: 되묻기 대화가 길어질수록 오류가 쌓일 수 있다는 근거. 과제가 코드, 수학 등 일반 생성이고 CS 대화는 아니다. 학회 게재 여부는 확인하지 못했다. 질문 횟수를 제한하고 상태를 구조화해 유지하는 설계를 정당화하는 쪽으로도 쓸 수 있다.

4. BURT 자체의 한계 (원문 확인, 2.6 참조)
   - 대화형 도구가 양식보다 관찰 동작을 더 부정확하게 받았다(16건 대 8건, 54건 중). 대화가 양식을 모든 면에서 앞서는 것은 아니라는 직접 증거.

한계: 비개발자 CS와 개발자 사이의 AI 중개가 서로의 이해를 떨어뜨린다는 직접 실험 연구는 찾지 못했다. 위 근거는 모두 간접 증거다.

## 6. 인용할 때

- 안전하게 말할 수 있는 것: Bettenburg FSE 2008의 불일치 설문(466 응답), Bettenburg ICSM 2008의 중복 병합 제안, BURT 평가에서 재현 단계 개선과 관찰 동작 악화, Mozilla 약 30%와 Eclipse 약 20% 중복(Anvik 인용).
- 말하지 말아야 할 것: Runeson의 "16~40% 중복", Zimmermann ICSE 2012의 "6~10% 재오픈", "BURT와 ChatBR 모두 양식보다 낫다", "CUEZILLA는 후속 도구".
- 열람하지 못한 원문: Runeson ICSE 2007 본문, ChatBR 본문, BURT FSE 2022 본문. 인용 전에 직접 열어 볼 것.
