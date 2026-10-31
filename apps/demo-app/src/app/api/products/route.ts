import { listProducts } from '../../../shop/products.ts';
import { shop } from '../../data.ts';

export async function GET() {
  const { db } = await shop();
  return Response.json(await listProducts(db));
}
