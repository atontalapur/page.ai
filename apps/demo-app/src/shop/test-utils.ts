import type { ShopSettings } from '../config.ts';
import type { Db } from '../db/index.ts';
import { seed } from '../db/seed.ts';
import { createTestDb } from '../db/test-utils.ts';
import { getProduct } from './products.ts';

export const settings: ShopSettings = {
  shippingFlatCents: 500,
  freeShippingMinCents: 5000,
  maxItemQuantity: 10,
  checkoutEnabled: true,
};

export async function seededDb(): Promise<Db> {
  const db = await createTestDb();
  await seed(db);
  return db;
}

export async function productId(db: Db, slug: string): Promise<number> {
  const product = await getProduct(db, slug);
  if (!product) throw new Error(`no seeded product ${slug}`);
  return product.id;
}
