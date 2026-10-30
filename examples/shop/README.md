# 작은 상점

상품 목록, 장바구니, 쿠폰, 결제, 주문 내역이 있는 작은 쇼핑몰 데모. 의존성 없이 Node 내장 http 서버와 바닐라 JS 로 돈다.

## 실행

Node 22 이상이 필요하다. 설치할 패키지는 없다.

```sh
npm start                    # http://localhost:5173
PORT=3000 npm start          # 포트 바꾸기 (PowerShell 은 $env:PORT=3000; npm start)
npm start -- --port 3000     # 인자로 바꾸기. PORT 보다 먼저 본다
```

데이터는 `data/*.json` 에서 읽고, 주문은 메모리에만 남는다. 서버를 다시 띄우면 주문 내역이 비워진다. 장바구니와 적용한 쿠폰은 브라우저 localStorage 에 있다.

## 화면

| 경로 | 화면 |
|---|---|
| `/` | 상품 목록 |
| `/products/:id` | 상품 상세, 장바구니 담기 |
| `/cart` | 장바구니, 수량 바꾸기 |
| `/checkout` | 결제. 쿠폰 적용, 상품 금액, 할인, 배송비, 최종 결제 금액 |
| `/orders/:id` | 주문 완료 |
| `/orders` | 내 주문 |

시험용 쿠폰

| 코드 | 종류 |
|---|---|
| `WELCOME5000` | 정액 5,000원 |
| `SALE10` | 정률 10% |

쿠폰, 배송비, 품절, 환불 기준은 [docs/policy.md](docs/policy.md) 에 있다.

## 구조

```
server.js          실행 진입점 (PORT, --port)
src/pricing.js     금액 계산. 서버와 브라우저가 같이 쓴다
src/cart.js        장바구니 상태
src/views.js       화면 HTML (순수 함수)
src/format.js      금액, 날짜 표시
src/server.js      http 서버와 API
public/            index.html, app.js, style.css
data/              상품, 쿠폰
test/              node:test
```

API

- `GET /api/products`, `GET /api/products/:id`
- `GET /api/coupons/:code`
- `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders` (`{ items: [{ id, qty }], couponCode }`)

주문 금액은 서버가 `src/pricing.js` 로 다시 계산해서 저장한다.

## 테스트

```sh
npm test            # 기본 테스트
```

## 문의 원문

`inquiries/` 에 고객 상담 기록 예시가 있다. 이름, 전화번호, 주소, 메일은 모두 지어낸 값이다.
