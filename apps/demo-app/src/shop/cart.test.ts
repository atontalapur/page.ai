import { describe, expect, it } from 'vitest';
import { addItem, ensureCart, getCart, removeItem, shippingFor } from './cart.ts';
import { productId, seededDb, settings } from './test-utils.ts';

describe('shippingFor', () => {
  it('is free for an empty cart and above the threshold', () => {
    expect(shippingFor(0, settings)).toBe(0);
    expect(shippingFor(4999, settings)).toBe(500);
    expect(shippingFor(5000, settings)).toBe(0);
  });
});

describe('cart', () => {
  it('creates a cart and keeps a known id', async () => {
    const db = await seededDb();
    const id = await ensureCart(db);
    expect(await ensureCart(db, id)).toBe(id);

    // A cookie can outlive a database reset; the cart row comes back.
    const stale = '00000000-0000-4000-8000-000000000000';
    expect(await ensureCart(db, stale)).toBe(stale);
    const { rows } = await db.query('select 1 from carts where id = $1', [stale]);
    expect(rows).toHaveLength(1);
  });

  it('is empty without an id', async () => {
    const db = await seededDb();
    expect(await getCart(db, undefined, settings)).toEqual({
      lines: [],
      subtotalCents: 0,
      shippingCents: 0,
      totalCents: 0,
    });
  });

  it('adds, accumulates and totals lines with shipping', async () => {
    const db = await seededDb();
    const cart = await ensureCart(db);
    const mug = await productId(db, 'enamel-mug');
    await addItem(db, cart, mug, 1, settings);
    await addItem(db, cart, mug, 1, settings);

    const result = await getCart(db, cart, settings);
    expect(result.lines).toEqual([
      expect.objectContaining({ slug: 'enamel-mug', quantity: 2, lineTotalCents: 3200 }),
    ]);
    expect(result).toMatchObject({ subtotalCents: 3200, shippingCents: 500, totalCents: 3700 });
  });

  it('rejects bad quantities, unknown products and short stock', async () => {
    const db = await seededDb();
    const cart = await ensureCart(db);
    const beanie = await productId(db, 'wool-beanie');
    const keyring = await productId(db, 'brass-keyring');

    await expect(addItem(db, cart, beanie, 0, settings)).rejects.toMatchObject({
      code: 'invalid_quantity',
    });
    await expect(addItem(db, cart, beanie, 1.5, settings)).rejects.toMatchObject({
      code: 'invalid_quantity',
    });
    await expect(addItem(db, cart, beanie, 11, settings)).rejects.toMatchObject({
      code: 'invalid_quantity',
    });
    await expect(addItem(db, cart, 99999, 1, settings)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(addItem(db, cart, keyring, 1, settings)).rejects.toMatchObject({
      code: 'out_of_stock',
    });
  });

  it('removes a line', async () => {
    const db = await seededDb();
    const cart = await ensureCart(db);
    const tote = await productId(db, 'canvas-tote');
    await addItem(db, cart, tote, 1, settings);
    await removeItem(db, cart, tote);
    expect((await getCart(db, cart, settings)).lines).toEqual([]);
  });
});
