import { describe, expect, it } from 'vitest';
import { escalationNoteFixture } from './__fixtures__/index.ts';
import { escalationNoteSchema } from './escalation.ts';
import { roundTrip } from './test-utils.ts';

describe('escalationNoteSchema', () => {
  it('round-trips the fixture', () => {
    expect(roundTrip(escalationNoteSchema, escalationNoteFixture)).toEqual(escalationNoteFixture);
  });

  it('rejects an empty summary or blocker', () => {
    expect(() => escalationNoteSchema.parse({ ...escalationNoteFixture, summary: ' ' })).toThrow();
    expect(() => escalationNoteSchema.parse({ ...escalationNoteFixture, blocker: '' })).toThrow();
  });
});
