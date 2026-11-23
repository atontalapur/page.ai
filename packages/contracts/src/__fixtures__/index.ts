// Valid fixtures for every contract. Consumer tests import these from
// `@page/contracts/fixtures` instead of building their own.
import type {
  ClosedChat,
  Confidence,
  DecidedApproval,
  Escalation,
  Issue,
  PendingApproval,
  PendingChat,
  Run,
  Step,
} from '../db.ts';
import type { EscalationNote } from '../escalation.ts';
import {
  nodeDecision,
  type NodeToServerEvents,
  type ServerToNodeEvents,
  type ServerToUiEvents,
  type UiToServerEvents,
} from '../events.ts';
import type { JobPayload, QueueName } from '../jobs.ts';
import type { NodeRun, NodeSummary } from '../nodes.ts';
import type { PosthogWebhook } from '../webhook.ts';

type Payloads<T extends Record<string, (payload: never) => void>> = {
  [K in keyof T]: Parameters<T[K]>[0];
};

const issueId = '3f2b9c1e-8a4d-4f6b-9c2e-1d7a5b8e4f01';
const runId = '7c1e4a2b-5d3f-4b8a-a1c9-6e2f8d4b3a02';
const approvalId = 'b4d8e2f1-9a3c-4e7b-8f2d-5c1a7e9b6d03';
const escalationId = 'e9a1c7d3-2b5f-4a8e-b3d6-8f4c2a1e7b04';
const chatId = 'c5e3a9b7-1d2f-4c6e-9a8b-3f7d1e5c2a05';
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
  confidence: null,
};

export const confidenceFixture: Confidence = {
  score: 0.8,
  changesCode: true,
  reproduced: false,
  testsPass: true,
  checksPass: true,
  liveAfterChange: null,
};

export const stepFixture: Step = {
  runId,
  seq: 0,
  kind: 'exec',
  input: 'rg -n "price" src/cart',
  outputTrimmed: 'src/cart/total.ts:12:  return items.slice(0, -1).reduce(sum, 0);',
  exitCode: 0,
  allowed: true,
  thought: 'The total is short by one item, so look at where cart lines are summed.',
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

export const pendingApprovalFixture: PendingApproval = {
  id: approvalId,
  runId,
  issueId,
  action: 'ops.setConfig',
  args: { tool: 'ops.setConfig', key: 'SHIPPING_FLAT_CENTS', value: '500' },
  decision: 'pending',
  decidedBy: null,
  requestedAt: at,
  expiresAt: '2026-10-30T12:03:00.000Z',
  reason: 'The live flat shipping fee is 2500000000 cents. Setting it back to 500 fixes the 500s.',
  decidedAt: null,
};

export const decidedApprovalFixture: DecidedApproval = {
  ...pendingApprovalFixture,
  decision: 'approved',
  decidedBy: 'ui:arjun',
  decidedAt: '2026-10-30T12:01:10.000Z',
};

export const pendingChatFixture: PendingChat = {
  id: chatId,
  runId,
  issueId,
  askedBy: 'ui:arjun',
  message: 'Check the pricing config first.',
  askedAt: '2026-10-30T12:01:00.000Z',
  status: 'pending',
  answer: null,
  reason: null,
  closedAt: null,
};

export const answeredChatFixture: ClosedChat = {
  ...pendingChatFixture,
  status: 'answered',
  answer: 'The config looks right; the total drops the last line, so I am reading total.ts.',
  closedAt: '2026-10-30T12:01:20.000Z',
};

export const jobFixtures: { [Q in QueueName]: JobPayload<Q> } = {
  triage: { v: 1, issueId },
  fix: {
    v: 1,
    issueId,
    runId,
    tier: 1,
    fingerprint,
    report: 'POST /api/cart/total 500\nTypeError: Cannot read properties of undefined',
  },
  notify: {
    v: 2,
    issueId,
    channel: 'call',
    to: '+15550000001',
    message: 'New high severity backend-api issue.',
  },
  run_finished: {
    v: 1,
    issueId,
    tier: 1,
    startedAt: at,
    finishedAt: later,
    diff: '--- a/src/cart/total.ts\n+++ b/src/cart/total.ts\n',
    result: {
      v: 1,
      runId,
      status: 'succeeded',
      prUrl: null,
      confidence: null,
      note: null,
      opsOnly: false,
    },
  },
};

export const nodeRunFixture: NodeRun = {
  ...runFixture,
  issueTitle: issueFixture.title,
  stepCount: 1,
  lastStep: stepFixture,
};

export const nodeSummaryFixture: NodeSummary = {
  name: 'railway-node-1',
  connected: true,
  since: at,
  current: [nodeRunFixture],
  lastRunAt: at,
};

export const serverToUiEventFixtures: Payloads<ServerToUiEvents> = {
  'issue.updated': { v: 1, issue: issueFixture },
  'run.started': { v: 1, run: runFixture },
  'run.step': { v: 1, step: stepFixture },
  'run.diff': { v: 1, runId, diff: '--- a/src/cart/total.ts\n+++ b/src/cart/total.ts\n' },
  'run.finished': {
    v: 1,
    run: { ...runFixture, status: 'escalated', finishedAt: later, confidence: confidenceFixture },
    note: escalationNoteFixture,
  },
  'approval.requested': { v: 1, approval: pendingApprovalFixture },
  'approval.updated': { v: 1, approval: decidedApprovalFixture },
  'node.updated': { v: 1, node: nodeSummaryFixture },
  'run.chat.asked': { v: 1, chat: pendingChatFixture },
  'run.chat.reply': { v: 1, chat: answeredChatFixture },
  'run.chat.refused': { v: 1, runId, reason: 'no_daemon' },
};

export const uiToServerEventFixtures: Payloads<UiToServerEvents> = {
  'run.kill': { v: 1, runId },
  'run.chat': { v: 1, runId, message: 'Check the pricing config first.' },
  'approval.decide': { v: 1, approvalId, decision: 'approved' },
};

export const nodeToServerEventFixtures: Payloads<NodeToServerEvents> = {
  'node.step': { v: 1, step: stepFixture },
  'node.holding': { v: 1, runIds: [runId] },
  'node.diff': { v: 1, runId, diff: '--- a/src/cart/total.ts\n+++ b/src/cart/total.ts\n' },
  'node.run.finished': {
    v: 1,
    runId,
    status: 'succeeded',
    prUrl: 'https://github.com/atontalapur/page-demo/pull/7',
    confidence: confidenceFixture,
    note: null,
    opsOnly: false,
  },
  'node.approval.request': {
    v: 1,
    approvalId,
    runId,
    action: pendingApprovalFixture.action,
    args: pendingApprovalFixture.args,
    expiresAt: pendingApprovalFixture.expiresAt,
    reason: pendingApprovalFixture.reason,
  },
  'node.chat.reply': {
    v: 1,
    chatId,
    runId,
    status: 'answered',
    answer: answeredChatFixture.answer,
  },
};

export const serverToNodeEventFixtures: Payloads<ServerToNodeEvents> = {
  'run.kill': uiToServerEventFixtures['run.kill'],
  'run.chat': {
    v: 1,
    chatId,
    runId,
    from: 'arjun',
    message: pendingChatFixture.message,
  },
  'approval.decided': { v: 1, approval: nodeDecision(decidedApprovalFixture) },
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
  OPENROUTER_MODEL: 'openai/gpt-5-mini',
  GITHUB_TOKEN: 'github_pat_test',
  GITHUB_REPO: 'atontalapur/page-demo',
};
