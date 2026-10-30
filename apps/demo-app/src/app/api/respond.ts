import type { ShopErrorCode } from '../../shop/errors.ts';
import { ShopError } from '../../shop/errors.ts';

const statusFor: Record<ShopErrorCode, number> = {
  not_found: 404,
  invalid_quantity: 400,
  out_of_stock: 409,
  empty_cart: 409,
  checkout_disabled: 503,
};

export function errorResponse(code: ShopErrorCode | 'bad_request', message: string): Response {
  return Response.json(
    { error: code, message },
    { status: code === 'bad_request' ? 400 : statusFor[code] },
  );
}

/** Runs `work`, turning a ShopError into its JSON error response. Other errors propagate. */
export async function handle(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ShopError) return errorResponse(err.code, err.message);
    throw err;
  }
}
