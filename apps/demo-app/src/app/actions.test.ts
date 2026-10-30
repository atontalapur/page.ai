import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCart } from '../shop/cart.ts';
import { productId } from '../shop/test-utils.ts';
import { addToCart, checkout, removeFromCart } from './actions.ts';
import { navigation, testShop, type TestShop } from './test-utils.ts';

const h = vi.hoisted(() => ({ ctx: undefined as unknown as TestShop }));
vi.mock('./data.ts', () => ({ shop: () => Promise.resolve(h.ctx) }));

function form(fields: Record<string, string | number>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
}

async function cartLines() {
  return (await getCart(h.ctx.db, h.ctx.jar.get('cart_id'), h.ctx.settings)).lines;
}

describe('server actions', () => {
  beforeEach(async () => {
    h.ctx = await testShop();
  });

  it('adds to a new cart, sets the cookie and goes to the cart', async () => {
    const mug = await productId(h.ctx.db, 'enamel-mug');
    expect(await navigation(addToCart(form({ productId: mug, quantity: 2 })))).toBe('/cart');
    expect(h.ctx.jar.get('cart_id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await cartLines()).toEqual([expect.objectContaining({ quantity: 2 })]);
  });

  it('shows a shop error on the cart page', async () => {
    const keyring = await productId(h.ctx.db, 'brass-keyring');
    expect(await navigation(addToCart(form({ productId: keyring })))).toBe(
      '/cart?error=out_of_stock',
    );
  });

  it('removes a line', async () => {
    const tote = await productId(h.ctx.db, 'canvas-tote');
    await navigation(addToCart(form({ productId: tote })));
    expect(await navigation(removeFromCart(form({ productId: tote })))).toBe('/cart');
    expect(await cartLines()).toEqual([]);
  });

  it('ignores a remove without a cart', async () => {
    expect(await navigation(removeFromCart(form({ productId: 1 })))).toBe('/cart');
  });

  it('checks out to the order page', async () => {
    await navigation(addToCart(form({ productId: await productId(h.ctx.db, 'enamel-mug') })));
    expect(await navigation(checkout())).toMatch(/^\/orders\/\d+$/);
  });

  it('sends an empty checkout back to the cart', async () => {
    expect(await navigation(checkout())).toBe('/cart?error=empty_cart');
  });

  it('lets unexpected errors through', async () => {
    h.ctx.jar.set('cart_id', '00000000-0000-4000-8000-000000000000');
    h.ctx.db.transaction = () => Promise.reject(new Error('db down'));
    await expect(checkout()).rejects.toThrow('db down');
  });
});
