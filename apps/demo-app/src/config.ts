import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Shop settings. These are the config surface the infra/config seeded bugs break.
  SHIPPING_FLAT_CENTS: z.coerce.number().int().min(0).default(500),
  FREE_SHIPPING_MIN_CENTS: z.coerce.number().int().min(0).default(5000),
  MAX_ITEM_QUANTITY: z.coerce.number().int().min(1).default(10),
  CHECKOUT_ENABLED: z.stringbool().default(true),
});

export type Config = z.infer<typeof schema>;

export interface ShopSettings {
  shippingFlatCents: number;
  freeShippingMinCents: number;
  maxItemQuantity: number;
  checkoutEnabled: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return schema.parse(env);
}

export function shopSettings(config: Config): ShopSettings {
  return {
    shippingFlatCents: config.SHIPPING_FLAT_CENTS,
    freeShippingMinCents: config.FREE_SHIPPING_MIN_CENTS,
    maxItemQuantity: config.MAX_ITEM_QUANTITY,
    checkoutEnabled: config.CHECKOUT_ENABLED,
  };
}
