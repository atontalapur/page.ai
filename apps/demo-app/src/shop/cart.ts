import type { ShopSettings } from '../config.ts';
import type { Queryable } from '../db/index.ts';
import { ShopError } from './errors.ts';

export interface CartLine {
  productId: number;
  slug: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Cart {
  lines: CartLine[];
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
}

export function shippingFor(subtotalCents: number, settings: ShopSettings): number {
  if (subtotalCents === 0 || subtotalCents >= settings.freeShippingMinCents) return 0;
  return settings.shippingFlatCents;
}

/** Returns `id` if given (recreating the row if the database was reset), else a new cart id. */
export async function ensureCart(db: Queryable, id?: string): Promise<string> {
  if (id) {
    await db.query('insert into carts (id) values ($1) on conflict (id) do nothing', [id]);
    return id;
  }
  const { rows } = await db.query<{ id: string }>('insert into carts default values returning id');
  return rows[0]!.id;
}

export async function getCart(
  db: Queryable,
  cartId: string | undefined,
  settings: ShopSettings,
): Promise<Cart> {
  const lines = cartId
    ? (
        await db.query<CartLine>(
          `select p.id as "productId", p.slug, p.name, p.price_cents as "unitPriceCents",
                  ci.quantity, p.price_cents * ci.quantity as "lineTotalCents"
           from cart_items ci join products p on p.id = ci.product_id
           where ci.cart_id = $1
           order by p.name`,
          [cartId],
        )
      ).rows
    : [];
  const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const shippingCents = shippingFor(subtotalCents, settings);
  return { lines, subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

/** Adds `quantity` to whatever is already in the cart for that product. */
export async function addItem(
  db: Queryable,
  cartId: string,
  productId: number,
  quantity: number,
  settings: ShopSettings,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ShopError('invalid_quantity', 'Quantity must be a positive whole number');
  }
  const { rows } = await db.query<{ stock: number; inCart: number }>(
    `select p.stock, coalesce(ci.quantity, 0) as "inCart"
     from products p
     left join cart_items ci on ci.product_id = p.id and ci.cart_id = $2
     where p.id = $1`,
    [productId, cartId],
  );
  const product = rows[0];
  if (!product) throw new ShopError('not_found', `No product with id ${productId}`);

  const total = product.inCart + quantity;
  if (total > settings.maxItemQuantity) {
    throw new ShopError('invalid_quantity', `At most ${settings.maxItemQuantity} per item`);
  }
  if (total > product.stock) {
    throw new ShopError('out_of_stock', `Only ${product.stock} left`);
  }
  await db.query(
    `insert into cart_items (cart_id, product_id, quantity) values ($1, $2, $3)
     on conflict (cart_id, product_id) do update set quantity = excluded.quantity`,
    [cartId, productId, total],
  );
}

export async function removeItem(db: Queryable, cartId: string, productId: number): Promise<void> {
  await db.query('delete from cart_items where cart_id = $1 and product_id = $2', [
    cartId,
    productId,
  ]);
}
