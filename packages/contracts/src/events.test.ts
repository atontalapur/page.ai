import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  confidenceFixture,
  escalationNoteFixture,
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

describe('node.run.finished', () => {
  const finished = nodeToServerEvents['node.run.finished'];
  const escalated = {
    v: 1,
    runId: nodeToServerEventFixtures['node.run.finished'].runId,
    status: 'escalated',
    prUrl: null,
    confidence: null,
    reason: 'tests_failing',
    toTier: 2,
    note: escalationNoteFixture,
  };

  it('round-trips an escalation with its reason, target tier and note', () => {
    expect(roundTrip(finished, escalated)).toEqual(escalated);
  });

  it.each(['reason', 'toTier'])('rejects an escalation without %s', (key) => {
    expect(() => finished.parse({ ...escalated, [key]: undefined })).toThrow();
  });

  it('rejects an escalation without a note', () => {
    expect(() => finished.parse({ ...escalated, note: null })).toThrow();
  });

  it('accepts a success the daemon did not score', () => {
    const unscored = { ...nodeToServerEventFixtures['node.run.finished'], confidence: null };
    expect(roundTrip(finished, unscored)).toEqual(unscored);
  });

  it('rejects a success with a malformed confidence score', () => {
    const succeeded = nodeToServerEventFixtures['node.run.finished'];
    const confidence = { ...confidenceFixture, score: 2 };
    expect(() => finished.parse({ ...succeeded, confidence })).toThrow();
  });

  it('accepts a killed run with nothing to report', () => {
    const killed = {
      v: 1,
      runId: escalated.runId,
      status: 'killed',
      prUrl: null,
      confidence: null,
      note: null,
    };
    expect(roundTrip(finished, killed)).toEqual(killed);
  });
});
