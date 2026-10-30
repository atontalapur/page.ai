import { getCart } from '../../../shop/cart.ts';
import { readCartId } from '../../cart-session.ts';
import { shop } from '../../data.ts';

export async function GET() {
  const { db, settings, cookies } = await shop();
  return Response.json(await getCart(db, readCartId(cookies), settings));
}
