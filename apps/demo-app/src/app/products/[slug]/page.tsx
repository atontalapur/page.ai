import { notFound } from 'next/navigation';
import { formatCents } from '../../../shop/money.ts';
import { getProduct } from '../../../shop/products.ts';
import { addToCart } from '../../actions.ts';
import { shop } from '../../data.ts';

export default async function ProductPage(props: PageProps<'/products/[slug]'>) {
  const { slug } = await props.params;
  const { db, settings } = await shop();
  const product = await getProduct(db, slug);
  if (!product) notFound();

  const soldOut = product.stock === 0;
  return (
    <main>
      <h1>{product.name}</h1>
      <p>{product.description}</p>
      <p>{formatCents(product.priceCents)}</p>
      <p>{soldOut ? 'Sold out' : `${product.stock} in stock`}</p>
      <form action={addToCart}>
        <input type="hidden" name="productId" value={product.id} />
        <label>
          Quantity{' '}
          <input
            type="number"
            name="quantity"
            defaultValue={1}
            min={1}
            max={Math.min(settings.maxItemQuantity, product.stock)}
          />
        </label>{' '}
        <button type="submit" disabled={soldOut}>
          Add to cart
        </button>
      </form>
    </main>
  );
}
