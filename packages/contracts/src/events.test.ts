import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  nodeToServerEventFixtures,
  serverToNodeEventFixtures,
  serverToUiEventFixtures,
  uiToServerEventFixtures,
} from './__fixtures__/index.ts';
import {
  nodeToServerEvents,
  serverToNodeEvents,
  serverToUiEvents,
  uiToServerEvents,
} from './events.ts';
import { roundTrip } from './test-utils.ts';

const directions: [string, Record<string, z.ZodType>, Record<string, unknown>][] = [
  ['server to UI', serverToUiEvents, serverToUiEventFixtures],
  ['UI to server', uiToServerEvents, uiToServerEventFixtures],
  ['node to server', nodeToServerEvents, nodeToServerEventFixtures],
  ['server to node', serverToNodeEvents, serverToNodeEventFixtures],
];

describe.each(directions)('%s events', (_, schemas, fixtures) => {
  const events = Object.entries(schemas);

  it.each(events)('%s round-trips its fixture', (event, schema) => {
    expect(roundTrip(schema, fixtures[event])).toEqual(fixtures[event]);
  });

  it.each(events)('%s rejects an unknown v', (event, schema) => {
    expect(() => schema.parse({ ...(fixtures[event] as object), v: 2 })).toThrow();
  });
});

it('rejects a UI decision that is still pending', () => {
  expect(() =>
    uiToServerEvents['approval.decide'].parse({
      ...uiToServerEventFixtures['approval.decide'],
      decision: 'pending',
    }),
  ).toThrow();
});
