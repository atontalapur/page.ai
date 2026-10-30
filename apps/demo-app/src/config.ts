import { z } from 'zod';

type Env = Record<string, string | undefined>;

// Kept apart from the shop settings so a bad setting can't take the database (or the
// healthcheck) down with it.
const databaseSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

// The config surface the infra/config seeded bugs break.
const shopSchema = z.object({
  SHIPPING_FLAT_CENTS: z.coerce.number().int().min(0).default(500),
  FREE_SHIPPING_MIN_CENTS: z.coerce.number().int().min(0).default(5000),
  MAX_ITEM_QUANTITY: z.coerce.number().int().min(1).default(10),
  CHECKOUT_ENABLED: z.stringbool().default(true),
});

export interface ShopSettings {
  shippingFlatCents: number;
  freeShippingMinCents: number;
  maxItemQuantity: number;
  checkoutEnabled: boolean;
}

export function databaseUrl(env: Env = process.env): string {
  return databaseSchema.parse(env).DATABASE_URL;
}

export function loadShopSettings(env: Env = process.env): ShopSettings {
  const config = shopSchema.parse(env);
  return {
    shippingFlatCents: config.SHIPPING_FLAT_CENTS,
    freeShippingMinCents: config.FREE_SHIPPING_MIN_CENTS,
    maxItemQuantity: config.MAX_ITEM_QUANTITY,
    checkoutEnabled: config.CHECKOUT_ENABLED,
  };
}
