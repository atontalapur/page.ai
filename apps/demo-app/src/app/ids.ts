import { z } from 'zod';

/** A `serial` primary key: a positive Postgres int4. */
export const idSchema = z.number().int().min(1).max(2_147_483_647);

/** Parses an id from a route param or form field; undefined if it isn't a valid id. */
export function parseId(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = idSchema.safeParse(Number(value));
  return parsed.success ? parsed.data : undefined;
}
