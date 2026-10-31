import { placeOrder } from '../../../shop/orders.ts';
import { readCartId } from '../../cart-session.ts';
import { shop } from '../../data.ts';
import { handle } from '../respond.ts';

export async function POST() {
  const { db, settings, cookies } = await shop();
  return handle(async () => {
    const orderId = await placeOrder(db, readCartId(cookies), settings);
    return Response.json({ orderId }, { status: 201 });
  });
}
