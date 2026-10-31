import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cart } from '../../shop/cart.ts';
import { productId } from '../../shop/test-utils.ts';
import { testShop, type TestShop } from '../test-utils.ts';
import { GET as getCart } from './cart/route.ts';
import { DELETE as removeItem } from './cart/items/[productId]/route.ts';
import { POST as addItem } from './cart/items/route.ts';
import { GET as getOrder } from './orders/[id]/route.ts';
import { POST as placeOrder } from './orders/route.ts';
import { GET as getProduct } from './products/[slug]/route.ts';
import { GET as listProducts } from './products/route.ts';

const h = vi.hoisted(() => ({ ctx: undefined as unknown as TestShop }));
vi.mock('../data.ts', () => ({ shop: () => Promise.resolve(h.ctx) }));

const req = new Request('http://localhost/');
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });
const post = (body: unknown) =>
  new Request('http://localhost/api/cart/items', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('API routes', () => {
  beforeEach(async () => {
    h.ctx = await testShop();
  });

  it('lists products and fetches one by slug', async () => {
    expect(await (await listProducts()).json()).toHaveLength(5);
    const res = await getProduct(req, ctx({ slug: 'enamel-mug' }));
    expect(await res.json()).toMatchObject({ name: 'Enamel Mug' });
    expect((await getProduct(req, ctx({ slug: 'nope' }))).status).toBe(404);
  });

  it('runs a cart through to an order', async () => {
    const mug = await productId(h.ctx.db, 'enamel-mug');
    const added = await addItem(post({ productId: mug, quantity: 2 }));
    expect(added.status).toBe(201);
    expect(((await added.json()) as Cart).totalCents).toBe(3700);
    expect(((await (await getCart()).json()) as Cart).lines).toHaveLength(1);

    const placed = await placeOrder();
    expect(placed.status).toBe(201);
    const { orderId } = (await placed.json()) as { orderId: number };
    const order = await getOrder(req, ctx({ id: String(orderId) }));
    expect(await order.json()).toMatchObject({ totalCents: 3700 });
  });

  it('removes a cart line', async () => {
    const tote = await productId(h.ctx.db, 'canvas-tote');
    await addItem(post({ productId: tote }));
    const res = await removeItem(req, ctx({ productId: String(tote) }));
    expect(((await res.json()) as Cart).lines).toEqual([]);
  });

  it('removing without a cart returns an empty cart', async () => {
    const res = await removeItem(req, ctx({ productId: '1' }));
    expect(((await res.json()) as Cart).lines).toEqual([]);
  });

  it('maps shop errors to status codes', async () => {
    const keyring = await productId(h.ctx.db, 'brass-keyring');
    expect((await addItem(post({ productId: keyring }))).status).toBe(409);
    expect((await addItem(post({ productId: 99999 }))).status).toBe(404);
    expect((await placeOrder()).status).toBe(409);

    h.ctx = await testShop({ checkoutEnabled: false });
    expect(await (await placeOrder()).json()).toEqual({
      error: 'checkout_disabled',
      message: 'Checkout is paused',
    });
  });

  it('rejects malformed bodies', async () => {
    expect((await addItem(post('not json'))).status).toBe(400);
    expect((await addItem(post({ productId: 'mug' }))).status).toBe(400);
    expect((await addItem(post({ productId: 9999999999 }))).status).toBe(400);
    expect((await removeItem(req, ctx({ productId: 'abc' }))).status).toBe(400);
  });

  it('404s an unknown or malformed order id', async () => {
    expect((await getOrder(req, ctx({ id: '999' }))).status).toBe(404);
    expect((await getOrder(req, ctx({ id: 'abc' }))).status).toBe(404);
    expect((await getOrder(req, ctx({ id: '9999999999' }))).status).toBe(404);
  });

  it('lets unexpected errors through', async () => {
    h.ctx.db.query = () => Promise.reject(new Error('db down'));
    await expect(addItem(post({ productId: 1 }))).rejects.toThrow('db down');
  });
});
