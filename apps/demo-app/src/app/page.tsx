import Link from 'next/link';
import { formatCents } from '../shop/money.ts';
import { listProducts } from '../shop/products.ts';
import { shop } from './data.ts';

export default async function HomePage() {
  const { db } = await shop();
  const products = await listProducts(db);

  return (
    <main>
      <h1>Products</h1>
      <ul className="products">
        {products.map((p) => (
          <li key={p.id}>
            <Link href={`/products/${p.slug}`}>{p.name}</Link>
            <div>{formatCents(p.priceCents)}</div>
            {p.stock === 0 && <div>Sold out</div>}
          </li>
        ))}
      </ul>
    </main>
  );
}
