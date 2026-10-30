import { getOrder } from '../../../../shop/orders.ts';
import { shop } from '../../../data.ts';
import { errorResponse } from '../../respond.ts';

export async function GET(_req: Request, ctx: RouteContext<'/api/orders/[id]'>) {
  const id = Number((await ctx.params).id);
  const { db } = await shop();
  const order = Number.isSafeInteger(id) ? await getOrder(db, id) : null;
  return order ? Response.json(order) : errorResponse('not_found', `No order ${id}`);
}
