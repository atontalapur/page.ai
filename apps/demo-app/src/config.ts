import { z } from 'zod';

export type Env = Record<string, string | undefined>;

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

/** The env names the shop settings are read from, and that runtime config may set. */
export type ShopSettingKey = keyof typeof shopSchema.shape;

export const SHOP_SETTING_KEYS = Object.keys(shopSchema.shape) as ShopSettingKey[];

export function isShopSettingKey(key: string): key is ShopSettingKey {
  return Object.hasOwn(shopSchema.shape, key);
}

/**
 * Checks one override value the way loadShopSettings reads it: null when it's valid, else
 * why not. Stricter than env in one way: a blank value is refused.
 */
export function checkShopSetting(key: ShopSettingKey, value: string): string | null {
  // z.coerce.number() reads '' as 0, so an empty override would silently mean zero.
  if (value.trim() === '') return 'must not be empty (delete the override to clear it)';
  const parsed = shopSchema.shape[key].safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid value');
}

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
