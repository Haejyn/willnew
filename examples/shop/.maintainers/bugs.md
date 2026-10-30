# 심은 버그와 정답 수정

**검증 전에 개발자 역할에게 보여 주지 않는다.** 검증 진행자만 본다. 별도 저장소로 뺄 때는 이 폴더를 빼고 옮긴다.

`npm run test:bugs` 는 아래 버그 4개를 재현하는 테스트 6개를 돌리고, 지금은 전부 실패한다. 정답 수정을 넣으면 6개 모두 통과하고 `npm test` 도 그대로 통과한다. 버그마다 테스트 파일이 따로라서 하나만 고쳐도 그 파일만 통과한다.

## 1. 정액 쿠폰이 최종 결제 금액에 안 들어감

- 문의: `inquiries/01-coupon-total.md`
- 증상: `WELCOME5000` 을 넣으면 결제 화면의 할인 줄은 `-5,000원` 인데 최종 결제 금액은 할인 전 그대로. `SALE10` 은 맞다. 서버도 같은 함수로 주문 금액을 저장해서 주문 완료와 내 주문 금액도 틀린다
- 위치: `src/pricing.js` 의 `calculateTotals` 가 최종 금액을 `applyCoupon(subtotal, coupon) + shipping` 으로 구한다. `applyCoupon` 은 정률 쿠폰만 처리하고 나머지는 상품 금액을 그대로 돌려준다. 할인 줄은 두 종류를 다 처리하는 `getDiscount` 를 쓰므로 둘이 어긋난다
- 재현 테스트: `test/bugs/coupon-total.test.js`
  - 정액 쿠폰을 적용하면 최종 결제 금액이 할인만큼 줄어든다
  - 최종 결제 금액은 상품 금액 - 할인 + 배송비
- 정답 수정

```js
const total = subtotal - discount + shipping;
```

`applyCoupon` 에 정액 분기를 넣어 고쳐도 테스트는 통과한다. 할인 계산이 두 군데 있는 게 원인이라 `getDiscount` 하나로 맞추고 `applyCoupon` 을 지우는 쪽이 낫다.

## 2. 배송비 경계값과 판단 기준

- 문의: `inquiries/02-shipping-fee.md`
- 증상 두 가지
  - 상품 금액이 정확히 30,000원이면 배송비 3,000원이 붙는다
  - 정책은 할인 후 금액 기준인데(`docs/policy.md` 배송비 절) 코드는 할인 전 금액으로 판단한다. 31,000원에 `SALE10` 을 쓰면 27,900원인데 배송비가 무료로 나온다
- 위치: `src/pricing.js`
  - `getShippingFee` 의 `amount > FREE_SHIPPING_MIN`
  - `calculateTotals` 의 `getShippingFee(subtotal)`
- 재현 테스트: `test/bugs/shipping.test.js`
  - 상품 금액이 정확히 30,000원이면 배송비 무료
  - 배송비는 할인 후 금액으로 판단한다
- 정답 수정

```js
return amount >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE;
// calculateTotals
const shipping = getShippingFee(subtotal - discount);
```

두 번째 문제는 문의 원문에 드러나지 않는다. 고객은 경계값만 말한다. 개발자가 정책 문서를 보고 같이 잡는지, 또는 `willnew ask` 로 기준을 묻는지 본다. 1번을 고치기 전에 `getShippingFee(applyCoupon(...))` 로 고치면 정액 쿠폰에서 여전히 틀린다.

## 3. 품절 상품 상세에서 장바구니 담기가 눌림

- 문의: `inquiries/03-sold-out.md`
- 증상: 재고 0인 캔버스 에코백(id 3)이 목록에서는 품절로 보이는데 상세 화면의 장바구니 담기 버튼이 눌리고 주문까지 된다
- 위치: `src/views.js` 의 `productDetail` 이 `product.soldOut` 으로 버튼을 막는다. 상품 데이터에는 `soldOut` 필드가 없고 `stock` 만 있다. 목록(`productList`)은 `isSoldOut(product)` 를 쓴다
- 재현 테스트: `test/bugs/sold-out.test.js`
  - 재고 0 상품 상세에서는 장바구니 담기 버튼이 눌리지 않는다
- 정답 수정

```js
<button id="add-to-cart" class="primary" data-id="${product.id}"${isSoldOut(product) ? " disabled" : ""}>장바구니 담기</button>
```

버튼 문구를 품절일 때 "품절" 로 바꾸거나 상세에도 품절 배지를 붙이면 더 좋다. 서버 `placeOrder` 도 재고를 보지 않아서 화면을 우회하면 품절 상품이 주문된다. 여기까지 고치면 가산점이고 테스트는 요구하지 않는다.

## 4. 주문 완료 문구 맞춤법

- 문의: `inquiries/04-order-complete-text.md`
- 증상: 주문 완료 화면 제목이 "주문이 완료되었읍니다"
- 위치: `src/views.js` 의 `orderComplete`
- 재현 테스트: `test/bugs/order-complete-text.test.js`
  - 주문 완료 화면 제목은 '주문이 완료되었습니다'
- 정답 수정: "주문이 완료되었습니다"
- 요청자 확인 흐름(전후 스크린샷, "의도대로예요")을 시험하는 용도

## 버그 아님: 쿠폰 두 개 같이 쓰기

- 문의: `inquiries/05-coupon-usage.md`
- 동작: 결제 화면에서 쿠폰을 새로 넣으면 앞의 쿠폰이 바뀐다(`src/cart.js` 의 `setCoupon`). 의도한 동작이다
- 근거: `docs/policy.md` 쿠폰 절 "쿠폰은 한 주문에 하나만 쓸 수 있다"
- 기대: willnew 가 티켓을 만들지 않고 정책 문서를 출처로 사용법 답변을 낸다

## 정답 확인 순서

1. `npm test` 통과, `npm run test:bugs` 6개 실패 확인
2. 위 수정 네 군데를 넣는다
3. `npm test` 와 `npm run test:bugs` 모두 통과
