import { getOrder } from '../../../../shop/orders.ts';
import { shop } from '../../../data.ts';
import { parseId } from '../../../ids.ts';
import { errorResponse } from '../../respond.ts';

export async function GET(_req: Request, ctx: RouteContext<'/api/orders/[id]'>) {
  const id = parseId((await ctx.params).id);
  if (id === undefined) return errorResponse('not_found', 'No such order');
  const { db } = await shop();
  const order = await getOrder(db, id);
  return order ? Response.json(order) : errorResponse('not_found', 'No such order');
}
