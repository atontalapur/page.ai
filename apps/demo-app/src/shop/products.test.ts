import { describe, expect, it } from 'vitest';
import { products } from '../db/seed.ts';
import { getProduct, listProducts } from './products.ts';
import { seededDb } from './test-utils.ts';

describe('products', () => {
  it('lists the catalogue by name', async () => {
    const db = await seededDb();
    const names = (await listProducts(db)).map((p) => p.name);
    expect(names).toEqual(products.map((p) => p.name).sort());
  });

  it('finds a product by slug, or null', async () => {
    const db = await seededDb();
    expect(await getProduct(db, 'enamel-mug')).toMatchObject({ priceCents: 1600, stock: 25 });
    expect(await getProduct(db, 'nope')).toBeNull();
  });
});
