export type ShopErrorCode =
  'not_found' | 'invalid_quantity' | 'out_of_stock' | 'empty_cart' | 'checkout_disabled';

/** An expected failure the shopper can act on. Anything else is a bug. */
export class ShopError extends Error {
  readonly code: ShopErrorCode;

  constructor(code: ShopErrorCode, message: string) {
    super(message);
    this.name = 'ShopError';
    this.code = code;
  }
}

export const errorMessages: Record<ShopErrorCode, string> = {
  not_found: 'That product no longer exists.',
  invalid_quantity: 'Pick a quantity within the limit.',
  out_of_stock: 'Not enough stock for that quantity.',
  empty_cart: 'Your cart is empty.',
  checkout_disabled: 'Checkout is paused right now.',
};
