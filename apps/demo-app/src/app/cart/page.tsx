import Link from 'next/link';
import { getCart } from '../../shop/cart.ts';
import { errorMessages, type ShopErrorCode } from '../../shop/errors.ts';
import { formatCents } from '../../shop/money.ts';
import { checkout, removeFromCart } from '../actions.ts';
import { readCartId } from '../cart-session.ts';
import { shop } from '../data.ts';

function messageFor(code: unknown): string | undefined {
  return typeof code === 'string' && code in errorMessages
    ? errorMessages[code as ShopErrorCode]
    : undefined;
}

export default async function CartPage(props: PageProps<'/cart'>) {
  const { error } = await props.searchParams;
  const { db, settings, cookies } = await shop();
  const cart = await getCart(db, readCartId(cookies), settings);
  const message = messageFor(error);

  return (
    <main>
      <h1>Cart</h1>
      {message && <p className="error">{message}</p>}
      {cart.lines.length === 0 ? (
        <p>
          Nothing here yet. <Link href="/">Browse products</Link>
        </p>
      ) : (
        <>
          <table>
            <tbody>
              {cart.lines.map((line) => (
                <tr key={line.productId}>
                  <td>
                    <Link href={`/products/${line.slug}`}>{line.name}</Link>
                  </td>
                  <td>× {line.quantity}</td>
                  <td>{formatCents(line.lineTotalCents)}</td>
                  <td>
                    <form action={removeFromCart}>
                      <input type="hidden" name="productId" value={line.productId} />
                      <button type="submit">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Subtotal {formatCents(cart.subtotalCents)}</p>
          <p>Shipping {formatCents(cart.shippingCents)}</p>
          <p>
            <strong>Total {formatCents(cart.totalCents)}</strong>
          </p>
          <form action={checkout}>
            <button type="submit" disabled={!settings.checkoutEnabled}>
              Place order
            </button>
          </form>
          {!settings.checkoutEnabled && <p>{errorMessages.checkout_disabled}</p>}
        </>
      )}
    </main>
  );
}
