import type { z } from 'zod';

/** Parses `value` after a JSON round-trip, the way it arrives off a queue or socket. */
export function roundTrip<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}
