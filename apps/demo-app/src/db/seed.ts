import type { Queryable } from './db.ts';

export interface SeedProduct {
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  stock: number;
}

export const products: SeedProduct[] = [
  {
    slug: 'canvas-tote',
    name: 'Canvas Tote',
    description: 'Heavy cotton tote with an inside pocket.',
    priceCents: 2400,
    stock: 40,
  },
  {
    slug: 'enamel-mug',
    name: 'Enamel Mug',
    description: '12 oz camp mug, dishwasher safe.',
    priceCents: 1600,
    stock: 25,
  },
  {
    slug: 'field-notebook',
    name: 'Field Notebook',
    description: 'Pack of three dot-grid notebooks.',
    priceCents: 1200,
    stock: 60,
  },
  {
    slug: 'wool-beanie',
    name: 'Wool Beanie',
    description: 'Merino rib knit, one size.',
    priceCents: 3200,
    stock: 15,
  },
  {
    slug: 'brass-keyring',
    name: 'Brass Keyring',
    description: 'Solid brass, ages with use.',
    priceCents: 900,
    stock: 0,
  },
];

/** Upserts the catalogue by slug, so running it twice resets names, prices and stock. */
export async function seed(db: Queryable): Promise<void> {
  for (const p of products) {
    await db.query(
      `insert into products (slug, name, description, price_cents, stock)
       values ($1, $2, $3, $4, $5)
       on conflict (slug) do update set
         name = excluded.name,
         description = excluded.description,
         price_cents = excluded.price_cents,
         stock = excluded.stock`,
      [p.slug, p.name, p.description, p.priceCents, p.stock],
    );
  }
}
