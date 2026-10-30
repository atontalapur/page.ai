'use server';

import { redirect } from 'next/navigation';
import { addItem, removeItem } from '../shop/cart.ts';
import { ShopError } from '../shop/errors.ts';
import { placeOrder } from '../shop/orders.ts';
import { openCart, readCartId } from './cart-session.ts';
import { shop } from './data.ts';

/** Sends a ShopError back to the cart page as a message; anything else is a bug. */
async function orShowError<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof ShopError) redirect(`/cart?error=${err.code}`);
    throw err;
  }
}

export async function addToCart(form: FormData) {
  const { db, settings, cookies } = await shop();
  const cartId = await openCart(db, cookies);
  const productId = Number(form.get('productId'));
  const quantity = Number(form.get('quantity') ?? 1);
  await orShowError(addItem(db, cartId, productId, quantity, settings));
  redirect('/cart');
}

export async function removeFromCart(form: FormData) {
  const { db, cookies } = await shop();
  const cartId = readCartId(cookies);
  if (cartId) await removeItem(db, cartId, Number(form.get('productId')));
  redirect('/cart');
}

export async function checkout() {
  const { db, settings, cookies } = await shop();
  const orderId = await orShowError(placeOrder(db, readCartId(cookies), settings));
  redirect(`/orders/${orderId}`);
}
