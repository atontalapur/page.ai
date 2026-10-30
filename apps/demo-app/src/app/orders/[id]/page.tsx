import { notFound } from 'next/navigation';
import { formatCents } from '../../../shop/money.ts';
import { getOrder } from '../../../shop/orders.ts';
import { shop } from '../../data.ts';

export default async function OrderPage(props: PageProps<'/orders/[id]'>) {
  const id = Number((await props.params).id);
  const { db } = await shop();
  const order = Number.isSafeInteger(id) ? await getOrder(db, id) : null;
  if (!order) notFound();

  return (
    <main>
      <h1>Order #{order.id}</h1>
      <p>Status: {order.status}</p>
      <ul>
        {order.items.map((item) => (
          <li key={item.productId}>
            {item.name} × {item.quantity} at {formatCents(item.unitPriceCents)}
          </li>
        ))}
      </ul>
      <p>Shipping {formatCents(order.shippingCents)}</p>
      <p>
        <strong>Total {formatCents(order.totalCents)}</strong>
      </p>
    </main>
  );
}
