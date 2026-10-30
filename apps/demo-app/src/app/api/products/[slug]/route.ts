import { getProduct } from '../../../../shop/products.ts';
import { shop } from '../../../data.ts';
import { errorResponse } from '../../respond.ts';

export async function GET(_req: Request, ctx: RouteContext<'/api/products/[slug]'>) {
  const { slug } = await ctx.params;
  const { db } = await shop();
  const product = await getProduct(db, slug);
  return product ? Response.json(product) : errorResponse('not_found', `No product ${slug}`);
}
