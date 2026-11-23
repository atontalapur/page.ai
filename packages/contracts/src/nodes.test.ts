import { describe, expect, it } from 'vitest';
import { nodeRunFixture, nodeSummaryFixture } from './__fixtures__/index.ts';
import {
  MAX_NODE_NAME_CHARS,
  nodeNameSchema,
  nodeRunSchema,
  nodeSummarySchema,
  toNodeName,
} from './nodes.ts';
import { roundTrip } from './test-utils.ts';

describe('nodeNameSchema', () => {
  it.each(['railway-node-1', 'Advaiths-MacBook-Pro.local', 'a1b2c3d4e5f6', 'node_2', '7'])(
    'takes %s',
    (name) => {
      expect(nodeNameSchema.parse(name)).toBe(name);
    },
  );

  it.each(['', '-node', '.local', 'my node', 'node/1', '../etc', 'nöde', 'a'.repeat(64)])(
    'refuses %j',
    (name) => {
      expect(nodeNameSchema.safeParse(name).success).toBe(false);
    },
  );
});

describe('toNodeName', () => {
  it('keeps a name that is already valid', () => {
    expect(toNodeName('railway-node-1')).toBe('railway-node-1');
  });

  it('replaces what a name cannot hold and drops a leading non-letter', () => {
    expect(toNodeName('my laptop')).toBe('my-laptop');
    expect(toNodeName('::ffff:127.0.0.1')).toBe('ffff-127.0.0.1');
    expect(toNodeName('-.node')).toBe('node');
  });

  it('cuts a long name, and names an empty one', () => {
    expect(toNodeName('a'.repeat(100))).toHaveLength(MAX_NODE_NAME_CHARS);
    expect(toNodeName('')).toBe('node');
    expect(toNodeName('***')).toBe('node');
  });

  it.each(['my laptop', '::1', 'ünïcode-host', 'x'.repeat(80), ''])(
    'always gives a valid name for %j',
    (raw) => {
      expect(nodeNameSchema.safeParse(toNodeName(raw)).success).toBe(true);
    },
  );
});

describe('nodeRunSchema', () => {
  it('round-trips its fixture, and one before its first step', () => {
    expect(roundTrip(nodeRunSchema, nodeRunFixture)).toEqual(nodeRunFixture);
    const queued = { ...nodeRunFixture, status: 'queued', stepCount: 0, lastStep: null };
    expect(roundTrip(nodeRunSchema, queued)).toEqual(queued);
  });

  it('refuses a negative step count and an unknown field', () => {
    expect(() => nodeRunSchema.parse({ ...nodeRunFixture, stepCount: -1 })).toThrow();
    expect(() => nodeRunSchema.parse({ ...nodeRunFixture, node: 'x' })).toThrow();
  });
});

describe('nodeSummarySchema', () => {
  it('round-trips its fixture, and a daemon known only from its runs', () => {
    expect(roundTrip(nodeSummarySchema, nodeSummaryFixture)).toEqual(nodeSummaryFixture);
    const past = { ...nodeSummaryFixture, connected: false, since: null, current: [] };
    expect(roundTrip(nodeSummarySchema, past)).toEqual(past);
  });

  it('refuses a name a daemon cannot have', () => {
    expect(() => nodeSummarySchema.parse({ ...nodeSummaryFixture, name: 'a b' })).toThrow();
  });
});
