import { getCart, removeItem } from '../../../../../shop/cart.ts';
import { captureServerEvent } from '../../../../../observability/analytics.ts';
import { logStorefrontOutcome } from '../../../../../observability/logs.ts';
import { readCartId } from '../../../../cart-session.ts';
import { shop } from '../../../../data.ts';
import { parseId } from '../../../../ids.ts';
import { errorResponse } from '../../../respond.ts';

export async function DELETE(_req: Request, ctx: RouteContext<'/api/cart/items/[productId]'>) {
  const productId = parseId((await ctx.params).productId);
  if (productId === undefined) return errorResponse('bad_request', 'Invalid product id');

  const { db, settings, cookies } = await shop();
  const cartId = readCartId(cookies);
  if (cartId) {
    await removeItem(db, cartId, productId);
    await captureServerEvent('api_cart_item_removed', { product_id: productId });
    logStorefrontOutcome('API cart item removed', { product_id: productId });
  }
  return Response.json(await getCart(db, cartId, settings));
}
