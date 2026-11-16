import { z } from 'zod';
import { addItem, getCart } from '../../../../shop/cart.ts';
import { openCart } from '../../../cart-session.ts';
import { shop } from '../../../data.ts';
import { idSchema } from '../../../ids.ts';
import { errorResponse, handle } from '../../respond.ts';

const body = z.object({
  productId: idSchema,
  quantity: z.number().int().default(1),
});

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return errorResponse('bad_request', 'Expected { productId, quantity? }');

  const { db, settings, cookies } = await shop();
  return handle(async () => {
    const cartId = await openCart(db, cookies);
    await addItem(db, cartId, parsed.data.productId, parsed.data.quantity, settings);
    return Response.json(await getCart(db, cartId, settings), { status: 201 });
  });
}
