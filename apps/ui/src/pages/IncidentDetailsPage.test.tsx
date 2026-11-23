// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import type { IssueRun, Step } from '@page/contracts';

import IncidentDetailsPage from './IncidentDetailsPage';
import { RUNS_POLL_MS } from '../components/issues/RunsPanel';
import { issue, renderWithIssues, testSource, type TestSource } from '../test-utils';

afterEach(() => {
  cleanup();
});

const fixing = issue(1, {
  title: 'Database connection timeout',
  status: 'fixing',
  class: 'database',
  severity: 'critical',
  occurrences: 24,
  currentTier: 2,
});
const fresh = issue(2, { status: 'new', class: null, severity: null, currentTier: null });

function run(
  tier: 1 | 2 | 3,
  status: IssueRun['status'],
  fields: Partial<IssueRun> = {},
): IssueRun {
  return {
    id: `${tier}0000000-2222-4222-8222-222222222222`,
    issueId: fixing.id,
    tier,
    status,
    startedAt: '2026-11-22T09:00:00.000Z',
    finishedAt: null,
    prUrl: null,
    confidence: null,
    diff: null,
    steps: [],
    ...fields,
  };
}

function step(seq: number, input: string, fields: Partial<Step> = {}): Step {
  return {
    runId: '10000000-2222-4222-8222-222222222222',
    seq,
    kind: 'exec',
    input,
    outputTrimmed: '',
    exitCode: 0,
    allowed: true,
    createdAt: '2026-11-22T09:00:00.000Z',
    ...fields,
  };
}

function renderDetails(id: string, source: TestSource = testSource([fixing, fresh])) {
  renderWithIssues(<IncidentDetailsPage />, source, {
    path: `/incidents/${id}`,
    route: '/incidents/:id',
  });
  return source;
}

function metric(label: string) {
  const title = screen.getByText(label, { selector: '[data-slot="card-title"]' });
  return within(title.closest('[data-slot="card"]') as HTMLElement);
}

describe('IncidentDetailsPage', () => {
  it("shows the issue's fields", () => {
    renderDetails(fixing.id);

    expect(screen.getByRole('heading', { name: fixing.title })).toBeTruthy();
    expect(screen.getByText(fixing.id.slice(0, 8))).toBeTruthy();
    expect(metric('Occurrences').getByText('24')).toBeTruthy();
    expect(metric('Class').getByText('Database')).toBeTruthy();
    expect(metric('Current Tier').getByText('Tier 2')).toBeTruthy();
    expect(
      metric('Last Updated').getByText(new Date(fixing.updatedAt).toLocaleString()),
    ).toBeTruthy();
    expect(screen.getByText(fixing.id)).toBeTruthy();
    expect(screen.getByText(fixing.fingerprint)).toBeTruthy();

    const badges = Array.from(document.querySelectorAll('[data-slot="badge"]'));
    expect(badges.map((badge) => badge.textContent)).toEqual(['Critical', 'Fixing']);
    for (const badge of badges) expect(badge.className).toMatch(/dark:bg-\w+-950/);
  });

  it('shows an untriaged issue as such', () => {
    renderDetails(fresh.id);

    expect(metric('Class').getByText('Untriaged')).toBeTruthy();
    expect(metric('Current Tier').getByText('None')).toBeTruthy();
    expect(screen.getByText('Untriaged', { selector: '[data-slot="badge"]' })).toBeTruthy();
  });

  it('lists each run with its steps, their results, the patch and the PR', async () => {
    const source = testSource([fixing, fresh]);
    source.runs.set(fixing.id, [
      run(1, 'escalated', {
        prUrl: 'https://github.com/o/page-demo/pull/7',
        diff: '--- a/src/shop/products.ts\n+++ b/src/shop/products.ts',
        steps: [
          step(0, 'pnpm test', { exitCode: 1, outputTrimmed: '1 failed' }),
          step(1, 'curl x', { allowed: false, exitCode: null }),
        ],
      }),
      run(2, 'running', { steps: [step(0, 'cat src/shop/products.ts')] }),
    ]);
    renderDetails(fixing.id, source);

    expect(await screen.findByText('pnpm test')).toBeTruthy();
    expect(screen.getByText('Escalated')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Exit 1')).toBeTruthy();
    expect(screen.getByText('Refused')).toBeTruthy();
    expect(screen.getByText('1 failed')).toBeTruthy();
    expect(screen.getByText(/\+\+\+ b\/src\/shop\/products\.ts/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe(
      'https://github.com/o/page-demo/pull/7',
    );
    expect(screen.getByText('cat src/shop/products.ts')).toBeTruthy();
  });

  it('says so when no agent has worked on the incident', async () => {
    renderDetails(fresh.id);
    expect(await screen.findByText('No agent has worked on this incident yet.')).toBeTruthy();
  });

  it('reloads the runs while the issue is fixing, for steps that send no event', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const source = testSource([fixing, fresh]);
      source.runs.set(fixing.id, [run(1, 'running', { steps: [step(0, 'ls')] })]);
      renderDetails(fixing.id, source);
      expect(await screen.findByText('ls')).toBeTruthy();

      source.runs.set(fixing.id, [
        run(1, 'running', { steps: [step(0, 'ls'), step(1, 'git diff')] }),
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RUNS_POLL_MS);
      });
      expect(screen.getByText('git diff')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates live from issue.updated', () => {
    const source = renderDetails(fixing.id);

    source.send({
      v: 1,
      issue: {
        ...fixing,
        status: 'awaiting_approval',
        occurrences: 25,
        updatedAt: '2026-11-22T12:00:00.000Z',
      },
    });

    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(metric('Occurrences').getByText('25')).toBeTruthy();
  });

  it('fetches an issue the list does not hold', async () => {
    const old = issue(40, { title: 'An old one' });
    const source = testSource([fixing]);
    source.extra.set(old.id, old);

    renderDetails(old.id, source);

    expect(await screen.findByRole('heading', { name: 'An old one' })).toBeTruthy();
  });

  it('says the incident does not exist once the lookup finds nothing', async () => {
    renderDetails('INC-001');

    expect(await screen.findByRole('heading', { name: 'Incident not found' })).toBeTruthy();
    const back = screen.getByRole('link', { name: 'Back to Incidents' });
    expect(back.getAttribute('href')).toBe('/incidents');
    expect(back.closest('button')).toBeNull();
  });

  it('asks for the token instead of saying not found', () => {
    renderDetails(fixing.id, testSource([], 'needs_token'));

    expect(screen.getByLabelText('API token')).toBeTruthy();
    expect(screen.queryByText('Loading incident...')).toBeNull();
  });

  it('renders a back link to the incidents page', () => {
    renderDetails(fixing.id);

    expect(screen.getByRole('link', { name: 'Back to Incidents' }).getAttribute('href')).toBe(
      '/incidents',
    );
  });
});
