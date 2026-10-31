import { describe, expect, it } from 'vitest';
import { products, seed } from './seed.ts';
import { createTestDb } from './test-utils.ts';

describe('seed', () => {
  it('is idempotent and resets stock', async () => {
    const db = await createTestDb();
    await seed(db);
    await db.query(`update products set stock = 999 where slug = 'enamel-mug'`);
    await seed(db);

    const { rows } = await db.query<{ slug: string; stock: number }>(
      'select slug, stock from products order by id',
    );
    expect(rows).toEqual(products.map((p) => ({ slug: p.slug, stock: p.stock })));
  });
});
