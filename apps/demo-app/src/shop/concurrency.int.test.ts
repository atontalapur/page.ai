import { afterAll, describe, expect, it } from 'vitest';
import { seed } from '../db/seed.ts';
import { createSchemaDb } from '../db/test-utils.ts';
import { addItem, ensureCart, getCart } from './cart.ts';
import { placeOrder } from './orders.ts';
import { getProduct } from './products.ts';
import { productId, settings } from './test-utils.ts';

const { db, close } = await createSchemaDb();
await seed(db);
afterAll(close);

describe('concurrent requests on one cart (real Postgres)', () => {
  it('counts every concurrent add', async () => {
    const cart = await ensureCart(db);
    const mug = await productId(db, 'enamel-mug');

    await Promise.all(Array.from({ length: 5 }, () => addItem(db, cart, mug, 1, settings)));

    expect((await getCart(db, cart, settings)).lines[0]?.quantity).toBe(5);
  });

  it('places one order for a double-submitted checkout', async () => {
    const cart = await ensureCart(db);
    await addItem(db, cart, await productId(db, 'wool-beanie'), 2, settings);

    const results = await Promise.allSettled([
      placeOrder(db, cart, settings),
      placeOrder(db, cart, settings),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'empty_cart' },
    });
    expect((await getProduct(db, 'wool-beanie'))?.stock).toBe(13);
  });
});
