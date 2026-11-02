import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  nodeToServerEventFixtures,
  pendingApprovalFixture,
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

it('rejects a node prUrl that is not https github.com', () => {
  expect(() =>
    nodeToServerEvents['node.run.finished'].parse({
      ...nodeToServerEventFixtures['node.run.finished'],
      prUrl: 'javascript:alert(1)',
    }),
  ).toThrow();
});

it('rejects a UI decision that names its own decider', () => {
  expect(() =>
    uiToServerEvents['approval.decide'].parse({
      ...uiToServerEventFixtures['approval.decide'],
      decidedBy: 'someone-else',
    }),
  ).toThrow();
});

it('rejects a pending approval sent as a decision to the node or the UI', () => {
  const pending = { v: 1, approval: pendingApprovalFixture };
  expect(() => serverToNodeEvents['approval.decided'].parse(pending)).toThrow();
  expect(() => serverToUiEvents['approval.updated'].parse(pending)).toThrow();
});
