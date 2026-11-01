import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addItem, ensureCart } from '../shop/cart.ts';
import { placeOrder } from '../shop/orders.ts';
import { productId } from '../shop/test-utils.ts';
import CartPage from './cart/page.tsx';
import RootLayout from './layout.tsx';
import OrderPage from './orders/[id]/page.tsx';
import HomePage from './page.tsx';
import ProductPage from './products/[slug]/page.tsx';
import { navigation, testShop, type TestShop } from './test-utils.ts';

const h = vi.hoisted(() => ({ ctx: undefined as unknown as TestShop }));
vi.mock('./data.ts', () => ({ shop: () => Promise.resolve(h.ctx) }));

const html = (el: ReactElement) => renderToStaticMarkup(el);
const props = <P,>(params: P, searchParams: Record<string, string> = {}) => ({
  params: Promise.resolve(params),
  searchParams: Promise.resolve(searchParams),
});

async function cartWith(slug: string, quantity = 1) {
  const cartId = await ensureCart(h.ctx.db);
  h.ctx.jar.set('cart_id', cartId);
  await addItem(h.ctx.db, cartId, await productId(h.ctx.db, slug), quantity, h.ctx.settings);
  return cartId;
}

describe('pages', () => {
  beforeEach(async () => {
    h.ctx = await testShop();
  });

  it('wraps pages in the layout with navigation', () => {
    const out = html(
      <RootLayout>
        <p>child</p>
      </RootLayout>,
    );
    expect(out).toContain('<html lang="en">');
    expect(out).toContain('href="/cart"');
    expect(out).toContain('<p>child</p>');
  });

  it('lists products and marks sold-out ones', async () => {
    const out = html(await HomePage());
    expect(out).toContain('href="/products/canvas-tote"');
    expect(out).toContain('$24.00');
    expect(out).toContain('Sold out');
  });

  it('shows a product with an add-to-cart form', async () => {
    const out = html(await ProductPage(props({ slug: 'enamel-mug' })));
    expect(out).toContain('<h1>Enamel Mug</h1>');
    expect(out).toContain('25 in stock');
    expect(out).toContain('max="10"');
  });

  it('disables add-to-cart for a sold-out product', async () => {
    const out = html(await ProductPage(props({ slug: 'brass-keyring' })));
    expect(out).toContain('Sold out');
    expect(out).toMatch(/<button type="submit" disabled="">/);
  });

  it('404s an unknown product', async () => {
    expect(await navigation(ProductPage(props({ slug: 'nope' })))).toBe('not-found');
  });

  it('shows an empty cart', async () => {
    const out = html(await CartPage(props({})));
    expect(out).toContain('Nothing here yet');
  });

  it('shows cart lines, totals and an error message', async () => {
    await cartWith('enamel-mug', 2);
    const out = html(await CartPage(props({}, { error: 'out_of_stock' })));
    expect(out).toContain('Enamel Mug');
    expect(out).toContain('Subtotal $32.00');
    expect(out).toContain('Shipping $5.00');
    expect(out).toContain('Total $37.00');
    expect(out).toContain('Not enough stock');
  });

  it('ignores an unknown error code and shows paused checkout', async () => {
    h.ctx = await testShop({ checkoutEnabled: false });
    await cartWith('canvas-tote');
    const out = html(await CartPage(props({}, { error: 'whatever' })));
    expect(out).not.toContain('class="error"');
    expect(out).toContain('Checkout is paused');
  });

  it('ignores inherited keys as error codes', async () => {
    for (const error of ['__proto__', 'toString', 'constructor']) {
      const out = html(await CartPage(props({}, { error })));
      expect(out).not.toContain('class="error"');
    }
  });

  it('shows a placed order', async () => {
    const cartId = await cartWith('wool-beanie');
    const id = await placeOrder(h.ctx.db, cartId, h.ctx.settings);
    const out = html(await OrderPage(props({ id: String(id) })));
    expect(out).toContain(`Order #${id}</h1>`);
    expect(out).toContain('Wool Beanie');
    expect(out).toMatch(/Placed \w+ \d+, \d{4}/);
  });

  it('404s an unknown or malformed order id', async () => {
    expect(await navigation(OrderPage(props({ id: '999' })))).toBe('not-found');
    expect(await navigation(OrderPage(props({ id: 'abc' })))).toBe('not-found');
    expect(await navigation(OrderPage(props({ id: '9999999999' })))).toBe('not-found');
  });
});
