import { placeOrder } from '../../../shop/orders.ts';
import { captureServerEvent } from '../../../observability/analytics.ts';
import { logStorefrontOutcome } from '../../../observability/logs.ts';
import { readCartId } from '../../cart-session.ts';
import { shop } from '../../data.ts';
import { handle } from '../respond.ts';

export async function POST() {
  const { db, settings, cookies } = await shop();
  return handle(async () => {
    const orderId = await placeOrder(db, readCartId(cookies), settings);
    await captureServerEvent('api_order_placed', { order_id: orderId });
    logStorefrontOutcome('API order placed', { order_id: orderId });
    return Response.json({ orderId }, { status: 201 });
  });
}
