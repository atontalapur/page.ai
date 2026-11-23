import { BUG_CLASSES, SEVERITIES, type Issue, type IssueStatus } from '@page/contracts';

import { isOpen } from '../lib/issueLabels';
import { parseIssueUpdated, type IssueFeed, type IssueSource } from './source';

const SEEDS: Pick<
  Issue,
  'title' | 'status' | 'class' | 'severity' | 'occurrences' | 'currentTier'
>[] = [
  {
    title: "TypeError: Cannot read properties of undefined (reading 'price')",
    status: 'fixing',
    class: 'backend-api',
    severity: 'high',
    occurrences: 3,
    currentTier: 1,
  },
  {
    title: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
    status: 'triaged',
    class: 'database',
    severity: 'critical',
    occurrences: 12,
    currentTier: null,
  },
  {
    title: "Hydration failed because the server rendered HTML didn't match the client",
    status: 'awaiting_approval',
    class: 'frontend',
    severity: 'medium',
    occurrences: 5,
    currentTier: 2,
  },
  {
    title: 'Error: Missing env var STRIPE_KEY',
    status: 'resolved',
    class: 'infra-config',
    severity: 'low',
    occurrences: 1,
    currentTier: 1,
  },
];

const ARRIVALS = [
  'RangeError: Invalid time value',
  'SyntaxError: Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
  'Error: timeout of 8000ms exceeded',
  'TypeError: items.map is not a function',
];

// Past this many open issues, a new arrival is a repeat of an open one instead.
const MAX_OPEN = 12;

/** A valid v4 uuid per number, with a first block that differs, since the UI shows it. */
export function mockId(n: number): string {
  const head = (Math.imul(n, 0x9e3779b1) >>> 0).toString(16).padStart(8, '0');
  return `${head}-7c3d-4e5f-8a6b-${n.toString(16).padStart(12, '0')}`;
}

export interface MockSource extends IssueSource {
  /** Plays the next scripted change now. */
  tick(): void;
  /** Delivers a raw `issue.updated` payload, through the same contract check as the server's. */
  push(payload: unknown): void;
}

export interface MockOptions {
  /** How often a scripted change plays. 0 plays none on its own (tests call tick()). */
  intervalMs?: number;
  now?: () => Date;
}

/**
 * Plays issue changes when no orchestrator is connected, so `pnpm --filter @page/ui dev`
 * shows the pages moving: an error arrives, gets triaged, repeats, starts a fix, escalates,
 * waits for approval and is approved. Every change goes out as an `issue.updated` payload and is parsed
 * like one from the server.
 */
export function mockSource({
  intervalMs = 4_000,
  now = () => new Date(),
}: MockOptions = {}): MockSource {
  const issues = new Map<string, Issue>();
  let count = 0;
  let ticks = 0;
  let feed: IssueFeed | undefined;

  function make(seed: (typeof SEEDS)[number], minutesAgo: number): Issue {
    count += 1;
    const at = new Date(now().getTime() - minutesAgo * 60_000).toISOString();
    return {
      id: mockId(count),
      fingerprint: `mock-${count}`,
      ...seed,
      createdAt: at,
      updatedAt: at,
    };
  }
  SEEDS.forEach((seed, i) => {
    const issue = make(seed, (i + 1) * 17);
    issues.set(issue.id, issue);
  });

  const sorted = () => [...issues.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const first = (status: IssueStatus) =>
    sorted()
      .reverse()
      .find((i) => i.status === status);

  function arrival(): Issue | undefined {
    if (sorted().filter(isOpen).length >= MAX_OPEN) return repeat();
    const title = ARRIVALS[count % ARRIVALS.length]!;
    return make(
      { title, status: 'new', class: null, severity: null, occurrences: 1, currentTier: null },
      0,
    );
  }

  function triage(): Issue | undefined {
    const issue = first('new');
    if (!issue) return arrival();
    return {
      ...issue,
      status: 'triaged',
      class: BUG_CLASSES[count % BUG_CLASSES.length]!,
      severity: SEVERITIES[count % SEVERITIES.length]!,
    };
  }

  function repeat(): Issue | undefined {
    const issue = sorted().find(isOpen);
    return issue && { ...issue, occurrences: issue.occurrences + 1 };
  }

  function startFix(): Issue | undefined {
    const issue = first('triaged');
    return issue ? { ...issue, status: 'fixing', currentTier: 1 } : repeat();
  }

  /** Escalates the oldest fix from Tier 1, or sends one at Tier 2 for approval. */
  function progress(): Issue | undefined {
    const issue = first('fixing');
    if (!issue) return repeat();
    if (issue.currentTier === 1) return { ...issue, currentTier: 2 };
    return { ...issue, status: 'awaiting_approval' };
  }

  function approve(): Issue | undefined {
    const issue = first('awaiting_approval');
    return issue ? { ...issue, status: 'resolved' } : repeat();
  }

  // One issue in and one out per round, so the list neither empties nor fills up.
  const script = [arrival, triage, repeat, startFix, progress, progress, approve];

  function push(payload: unknown) {
    const issue = parseIssueUpdated(payload);
    if (!issue) return;
    issues.set(issue.id, issue);
    feed?.update(issue);
  }

  function tick() {
    const step = script[ticks % script.length]!;
    ticks += 1;
    const changed = step();
    if (changed) push({ v: 1, issue: { ...changed, updatedAt: now().toISOString() } });
  }

  return {
    start(next) {
      feed = next;
      feed.status('mock');
      feed.reset(sorted());
      const timer = intervalMs > 0 ? setInterval(tick, intervalMs) : undefined;
      return () => {
        clearInterval(timer);
        feed = undefined;
      };
    },
    tick,
    push,
    fetchIssue: (id) => Promise.resolve(issues.get(id)),
    // The mock plays issues only; its fixes have no runs to show.
    fetchRuns: () => Promise.resolve([]),
    applyEvent: () => Promise.reject(new Error('Mock data has no orchestrator to review with.')),
  };
}
