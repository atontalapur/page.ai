import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { ensureCart } from '../shop/cart.ts';
import type { CookieStore } from './data.ts';

const COOKIE = 'cart_id';
const THIRTY_DAYS = 60 * 60 * 24 * 30;

export function readCartId(cookies: CookieStore): string | undefined {
  const parsed = z.uuid().safeParse(cookies.get(COOKIE)?.value);
  return parsed.success ? parsed.data : undefined;
}

/** Returns the shopper's cart id, creating the cart and cookie if needed. Actions and handlers only. */
export async function openCart(db: Db, cookies: CookieStore): Promise<string> {
  const id = await ensureCart(db, readCartId(cookies));
  cookies.set(COOKIE, id, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: THIRTY_DAYS });
  return id;
}
