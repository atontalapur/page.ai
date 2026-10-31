import type { Queryable } from '../db/index.ts';

export interface Product {
  id: number;
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  stock: number;
}

const columns = `id, slug, name, description, price_cents as "priceCents", stock`;

export async function listProducts(db: Queryable): Promise<Product[]> {
  const { rows } = await db.query<Product>(`select ${columns} from products order by name`);
  return rows;
}

export async function getProduct(db: Queryable, slug: string): Promise<Product | null> {
  const { rows } = await db.query<Product>(`select ${columns} from products where slug = $1`, [
    slug,
  ]);
  return rows[0] ?? null;
}
