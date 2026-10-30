import { describe, expect, it } from 'vitest';
import { addItem, ensureCart, getCart } from './cart.ts';
import { getOrder, placeOrder } from './orders.ts';
import { getProduct } from './products.ts';
import { productId, seededDb, settings } from './test-utils.ts';

describe('placeOrder', () => {
  it('creates the order, takes stock and empties the cart', async () => {
    const db = await seededDb();
    const cart = await ensureCart(db);
    await addItem(db, cart, await productId(db, 'wool-beanie'), 2, settings);

    const id = await placeOrder(db, cart, settings);

    expect(await getOrder(db, id)).toMatchObject({
      status: 'placed',
      subtotalCents: 6400,
      shippingCents: 0,
      totalCents: 6400,
      items: [{ name: 'Wool Beanie', quantity: 2, unitPriceCents: 3200 }],
    });
    expect((await getProduct(db, 'wool-beanie'))?.stock).toBe(13);
    expect((await getCart(db, cart, settings)).lines).toEqual([]);
  });

  it('refuses when checkout is disabled or the cart is empty', async () => {
    const db = await seededDb();
    const cart = await ensureCart(db);

    await expect(
      placeOrder(db, cart, { ...settings, checkoutEnabled: false }),
    ).rejects.toMatchObject({ code: 'checkout_disabled' });
    await expect(placeOrder(db, undefined, settings)).rejects.toMatchObject({
      code: 'empty_cart',
    });
    await expect(placeOrder(db, cart, settings)).rejects.toMatchObject({ code: 'empty_cart' });
  });

  it('rolls back when stock ran out after the item was added', async () => {
    const db = await seededDb();
    const cart = await ensureCart(db);
    await addItem(db, cart, await productId(db, 'enamel-mug'), 3, settings);
    await db.query(`update products set stock = 2 where slug = 'enamel-mug'`);

    await expect(placeOrder(db, cart, settings)).rejects.toMatchObject({ code: 'out_of_stock' });
    expect((await getCart(db, cart, settings)).lines).toHaveLength(1);
    const { rows } = await db.query('select id from orders');
    expect(rows).toEqual([]);
  });
});

describe('getOrder', () => {
  it('returns null for an unknown id', async () => {
    expect(await getOrder(await seededDb(), 404)).toBeNull();
  });
});
