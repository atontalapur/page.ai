import { notFound } from 'next/navigation';
import { formatCents } from '../../../shop/money.ts';
import { getOrder } from '../../../shop/orders.ts';
import { shop } from '../../data.ts';
import { parseId } from '../../ids.ts';

export default async function OrderPage(props: PageProps<'/orders/[id]'>) {
  const id = parseId((await props.params).id);
  if (id === undefined) notFound();
  const { db } = await shop();
  const order = await getOrder(db, id);
  if (!order) notFound();

  return (
    <main>
      <h1>Order #{order.id}</h1>
      <p>Status: {order.status}</p>
      <p>Placed {order.createdAt.toLocaleDateString('en-US', { dateStyle: 'long' })}</p>
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
