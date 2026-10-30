import type { ShopSettings } from '../config.ts';
import type { Db, Queryable } from '../db/index.ts';
import { lockCart, shippingFor } from './cart.ts';
import { ShopError } from './errors.ts';

export interface OrderItem {
  productId: number;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: number;
  status: 'placed' | 'cancelled';
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  createdAt: Date;
  items: OrderItem[];
}

/**
 * Turns the cart into an order in one transaction: locks the cart and its products,
 * checks stock, decrements it and removes the ordered lines. Returns the new order id.
 */
export async function placeOrder(
  db: Db,
  cartId: string | undefined,
  settings: ShopSettings,
): Promise<number> {
  if (!settings.checkoutEnabled) throw new ShopError('checkout_disabled', 'Checkout is paused');
  if (!cartId) throw new ShopError('empty_cart', 'Cart is empty');

  return db.transaction(async (tx) => {
    // Without this, a double-submitted checkout reads the same lines twice and orders them twice.
    if (!(await lockCart(tx, cartId))) throw new ShopError('empty_cart', 'Cart is empty');
    const { rows: lines } = await tx.query<OrderItem & { stock: number }>(
      `select p.id as "productId", p.name, p.stock, p.price_cents as "unitPriceCents", ci.quantity
       from cart_items ci join products p on p.id = ci.product_id
       where ci.cart_id = $1
       order by p.id
       for update of p`,
      [cartId],
    );
    if (lines.length === 0) throw new ShopError('empty_cart', 'Cart is empty');
    const short = lines.find((line) => line.quantity > line.stock);
    if (short) throw new ShopError('out_of_stock', `Only ${short.stock} ${short.name} left`);

    const subtotalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
    const shippingCents = shippingFor(subtotalCents, settings);
    const { rows } = await tx.query<{ id: number }>(
      `insert into orders (subtotal_cents, shipping_cents, total_cents)
       values ($1, $2, $3) returning id`,
      [subtotalCents, shippingCents, subtotalCents + shippingCents],
    );
    const orderId = rows[0]!.id;

    for (const line of lines) {
      await tx.query(
        `insert into order_items (order_id, product_id, quantity, unit_price_cents)
         values ($1, $2, $3, $4)`,
        [orderId, line.productId, line.quantity, line.unitPriceCents],
      );
      await tx.query('update products set stock = stock - $1 where id = $2', [
        line.quantity,
        line.productId,
      ]);
    }
    await tx.query('delete from cart_items where cart_id = $1 and product_id = any($2::int[])', [
      cartId,
      lines.map((line) => line.productId),
    ]);
    return orderId;
  });
}

export async function getOrder(db: Queryable, id: number): Promise<Order | null> {
  const { rows } = await db.query<Omit<Order, 'items'>>(
    `select id, status, subtotal_cents as "subtotalCents", shipping_cents as "shippingCents",
            total_cents as "totalCents", created_at as "createdAt"
     from orders where id = $1`,
    [id],
  );
  const order = rows[0];
  if (!order) return null;

  const { rows: items } = await db.query<OrderItem>(
    `select oi.product_id as "productId", p.name, oi.quantity, oi.unit_price_cents as "unitPriceCents"
     from order_items oi join products p on p.id = oi.product_id
     where oi.order_id = $1
     order by p.name`,
    [id],
  );
  return { ...order, items };
}
