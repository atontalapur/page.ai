import { getCart, removeItem } from '../../../../../shop/cart.ts';
import { readCartId } from '../../../../cart-session.ts';
import { shop } from '../../../../data.ts';

export async function DELETE(_req: Request, ctx: RouteContext<'/api/cart/items/[productId]'>) {
  const productId = Number((await ctx.params).productId);
  const { db, settings, cookies } = await shop();
  const cartId = readCartId(cookies);
  if (cartId) await removeItem(db, cartId, productId);
  return Response.json(await getCart(db, cartId, settings));
}
