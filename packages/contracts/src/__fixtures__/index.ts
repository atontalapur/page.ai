// Valid fixtures for every contract. Consumer tests import these from
// `@page/contracts/fixtures` instead of building their own.
import type { Approval, Escalation, Issue, Run, Step } from '../db.ts';
import type { EscalationNote } from '../escalation.ts';
import type {
  NodeToServerEvents,
  ServerToNodeEvents,
  ServerToUiEvents,
  UiToServerEvents,
} from '../events.ts';
import type { JobPayload, QueueName } from '../jobs.ts';
import type { PosthogWebhook } from '../webhook.ts';

type Payloads<T extends Record<string, (payload: never) => void>> = {
  [K in keyof T]: Parameters<T[K]>[0];
};

const issueId = '3f2b9c1e-8a4d-4f6b-9c2e-1d7a5b8e4f01';
const runId = '7c1e4a2b-5d3f-4b8a-a1c9-6e2f8d4b3a02';
const approvalId = 'b4d8e2f1-9a3c-4e7b-8f2d-5c1a7e9b6d03';
const escalationId = 'e9a1c7d3-2b5f-4a8e-b3d6-8f4c2a1e7b04';
const fingerprint = '01934f5e-7a2b-7c3d-8e4f-5a6b7c8d9e0f';
const at = '2026-10-30T12:00:00.000Z';
const later = '2026-10-30T12:04:30.000Z';

export const issueFixture: Issue = {
  id: issueId,
  fingerprint,
  title: 'TypeError: Cannot read properties of undefined (reading "price")',
  status: 'fixing',
  class: 'backend-api',
  severity: 'high',
  occurrences: 3,
  currentTier: 1,
  createdAt: at,
  updatedAt: later,
};

export const runFixture: Run = {
  id: runId,
  issueId,
  tier: 1,
  status: 'running',
  startedAt: at,
  finishedAt: null,
  prUrl: null,
};

export const stepFixture: Step = {
  runId,
  seq: 0,
  kind: 'exec',
  input: 'rg -n "price" src/cart',
  outputTrimmed: 'src/cart/total.ts:12:  return items.slice(0, -1).reduce(sum, 0);',
  exitCode: 0,
  allowed: true,
  createdAt: at,
};

export const escalationNoteFixture: EscalationNote = {
  summary: 'The cart total bug is in the pricing service config, which Tier 1 cannot edit.',
  tried: ['Read src/cart/total.ts', 'Ran the cart tests: 2 failing'],
  blocker: 'The fix needs a config change, which is a Tier 3 action.',
};

export const escalationFixture: Escalation = {
  id: escalationId,
  runId,
  fromTier: 1,
  toTier: 3,
  reason: 'needs_higher_tier',
  note: escalationNoteFixture,
  createdAt: later,
};

export const pendingApprovalFixture: Approval = {
  id: approvalId,
  runId,
  action: 'ops.restart',
  args: { service: 'api' },
  decision: 'pending',
  decidedBy: null,
  requestedAt: at,
  decidedAt: null,
};

export const decidedApprovalFixture: Approval = {
  ...pendingApprovalFixture,
  decision: 'approved',
  decidedBy: 'arjun',
  decidedAt: later,
};

export const jobFixtures: { [Q in QueueName]: JobPayload<Q> } = {
  triage: { v: 1, issueId },
  'fix.tier1': { v: 1, issueId, runId, fingerprint },
  'fix.tier2': { v: 1, issueId, runId, fingerprint },
  'fix.tier3': { v: 1, issueId, runId, fingerprint },
  notify: { v: 1, issueId, channel: 'call', message: 'New high severity backend-api issue.' },
};

export const serverToUiEventFixtures: Payloads<ServerToUiEvents> = {
  'issue.updated': { v: 1, issue: issueFixture },
  'run.started': { v: 1, run: runFixture },
  'run.step': { v: 1, step: stepFixture },
  'run.diff': { v: 1, runId, diff: '--- a/src/cart/total.ts\n+++ b/src/cart/total.ts\n' },
  'run.finished': {
    v: 1,
    run: { ...runFixture, status: 'escalated', finishedAt: later },
    note: escalationNoteFixture,
  },
  'approval.requested': { v: 1, approval: pendingApprovalFixture },
};

export const uiToServerEventFixtures: Payloads<UiToServerEvents> = {
  'run.kill': { v: 1, runId },
  'run.chat': { v: 1, runId, message: 'Check the pricing config first.' },
  'approval.decide': { v: 1, approvalId, decision: 'approved', decidedBy: 'arjun' },
};

export const nodeToServerEventFixtures: Payloads<NodeToServerEvents> = {
  'node.step': { v: 1, step: stepFixture },
  'node.diff': { v: 1, runId, diff: '--- a/src/cart/total.ts\n+++ b/src/cart/total.ts\n' },
  'node.run.finished': {
    v: 1,
    runId,
    status: 'succeeded',
    prUrl: 'https://github.com/atontalapur/page-demo/pull/7',
    note: null,
  },
};

export const serverToNodeEventFixtures: Payloads<ServerToNodeEvents> = {
  'run.kill': uiToServerEventFixtures['run.kill'],
  'run.chat': uiToServerEventFixtures['run.chat'],
};

export const posthogWebhookFixture: PosthogWebhook = {
  event: {
    uuid: '01934f60-1b2c-7d3e-9f4a-5b6c7d8e9f10',
    event: '$exception',
    timestamp: at,
    properties: {
      $exception_issue_id: fingerprint,
      $exception_types: ['TypeError'],
      $exception_values: ['Cannot read properties of undefined (reading "price")'],
    },
  },
};

/** A complete orchestrator env with real adapters, as `process.env` would hold it. */
export const orchestratorEnvFixture = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  USE_FAKE_ADAPTERS: 'false',
  DATABASE_URL: 'postgres://page:page@localhost:5432/page',
  PORT: '8080',
  NODE_SHARED_SECRET: 'node-secret',
  POSTHOG_WEBHOOK_SECRET: 'webhook-secret',
  OPENROUTER_API_KEY: 'sk-or-test',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'twilio-token',
  TWILIO_FROM_NUMBER: '+15550000000',
  NOTIFY_TO_NUMBERS: '+15550000001, +15550000002',
};

/** A complete node daemon env with real adapters. */
export const nodeEnvFixture = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  USE_FAKE_ADAPTERS: 'false',
  DATABASE_URL: 'postgres://page:page@localhost:5432/page',
  ORCHESTRATOR_URL: 'https://orchestrator.example.com',
  NODE_SHARED_SECRET: 'node-secret',
  OPENROUTER_API_KEY: 'sk-or-test',
  GITHUB_TOKEN: 'github_pat_test',
  GITHUB_REPO: 'atontalapur/page-demo',
};
