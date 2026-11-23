import { describe, expect, it } from 'vitest';
import { sessionSchema } from './session.ts';
import { roundTrip } from './test-utils.ts';

describe('sessionSchema', () => {
  it('round-trips a personal token and the shared one', () => {
    const person = { token: 'personal', name: 'Arjun' };
    const shared = { token: 'shared', canDecide: false };
    expect(roundTrip(sessionSchema, person)).toEqual(person);
    expect(roundTrip(sessionSchema, shared)).toEqual(shared);
  });

  it('refuses a personal token without a name a person may have', () => {
    expect(sessionSchema.safeParse({ token: 'personal' }).success).toBe(false);
    expect(sessionSchema.safeParse({ token: 'personal', name: 'system:run' }).success).toBe(false);
    expect(sessionSchema.safeParse({ token: 'shared', name: 'Arjun' }).success).toBe(false);
  });
});
