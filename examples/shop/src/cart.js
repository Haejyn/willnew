// 장바구니 상태. { items: [{ id, qty }], couponCode: string | null }

export function emptyCart() {
  return { items: [], couponCode: null };
}

export function addItem(cart, id, qty = 1) {
  const found = cart.items.find((item) => item.id === id);
  const items = found
    ? cart.items.map((item) => (item.id === id ? { ...item, qty: item.qty + qty } : item))
    : [...cart.items, { id, qty }];
  return { ...cart, items };
}

export function setQty(cart, id, qty) {
  if (qty <= 0) return removeItem(cart, id);
  return { ...cart, items: cart.items.map((item) => (item.id === id ? { ...item, qty } : item)) };
}

export function removeItem(cart, id) {
  return { ...cart, items: cart.items.filter((item) => item.id !== id) };
}

// 쿠폰은 한 주문에 하나. 새로 넣으면 앞의 쿠폰을 바꾼다.
export function setCoupon(cart, code) {
  return { ...cart, couponCode: code || null };
}

export function itemCount(cart) {
  return cart.items.reduce((sum, item) => sum + item.qty, 0);
}

// 장바구니 항목을 상품 정보와 합친다. 없어진 상품은 뺀다.
export function toLines(cart, products) {
  return cart.items
    .map((item) => {
      const product = products.find((p) => p.id === item.id);
      return product ? { id: product.id, name: product.name, price: product.price, qty: item.qty } : null;
    })
    .filter(Boolean);
}
