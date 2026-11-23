// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import IncidentsPage from './IncidentsPage';
import { issue, renderWithIssues, testSource } from '../test-utils';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const issues = [
  issue(1, { title: 'Database connection timeout', status: 'fixing', severity: 'critical' }),
  issue(2, {
    title: 'Hydration failed',
    status: 'awaiting_approval',
    class: 'frontend',
    severity: 'medium',
    currentTier: 2,
  }),
  issue(3, {
    title: 'Missing env var',
    status: 'resolved',
    class: 'infra-config',
    severity: 'low',
  }),
  issue(4, {
    title: 'Fresh error',
    status: 'new',
    class: null,
    severity: null,
    currentTier: null,
    occurrences: 1,
  }),
];

function renderPage(list = issues) {
  const source = testSource(list);
  renderWithIssues(<IncidentsPage />, source);
  return source;
}

const rows = () => screen.getAllByRole('row').slice(1);
const rowOf = (id: string) => document.querySelector(`[data-issue-id="${id}"]`) as HTMLElement;

function metric(label: string) {
  const title = screen.getByText(label, { selector: '[data-slot="card-title"]' });
  return within(title.closest('[data-slot="card"]') as HTMLElement);
}

describe('IncidentsPage', () => {
  it('lists every issue, most recently updated first', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Incidents' })).toBeTruthy();
    expect(rows().map((row) => row.getAttribute('data-issue-id'))).toEqual(
      [...issues].reverse().map((i) => i.id),
    );
    expect(screen.getByLabelText('4 incidents')).toBeTruthy();
  });

  it("shows each issue's status, class, severity, occurrences and tier", () => {
    renderPage();

    const fixing = within(rowOf(issues[0]!.id));
    expect(fixing.getByText('Fixing')).toBeTruthy();
    expect(fixing.getByText('Backend API')).toBeTruthy();
    expect(fixing.getByText('Critical')).toBeTruthy();
    expect(fixing.getByText('3')).toBeTruthy();
    expect(fixing.getByText('Tier 1')).toBeTruthy();

    const fresh = within(rowOf(issues[3]!.id));
    expect(fresh.getByText('New')).toBeTruthy();
    expect(fresh.getAllByText('Untriaged')).toHaveLength(2);
    expect(fresh.getByText('None')).toBeTruthy();
  });

  it('counts the metric cards from the issues', () => {
    renderPage();

    expect(metric('Total Incidents').getByText('4')).toBeTruthy();
    expect(metric('Open Incidents').getByText('3')).toBeTruthy();
    expect(metric('Critical Incidents').getByText('1')).toBeTruthy();
    expect(metric('Awaiting Approval').getByText('1')).toBeTruthy();
  });

  it('links each row to its detail page', () => {
    renderPage();

    for (const i of issues) {
      const link = within(rowOf(i.id)).getByRole('link');
      expect(link.getAttribute('href')).toBe(`/incidents/${i.id}`);
      expect(link.textContent).toContain(i.id.slice(0, 8));
    }
  });

  it('filters by search, status and severity', () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('Search incidents...'), {
      target: { value: 'hydration' },
    });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText('Search incidents...'), {
      target: { value: 'fp-3' },
    });
    expect(within(rows()[0]!).getByText('Missing env var')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search incidents...'), {
      target: { value: '' },
    });

    const status = screen.getByRole('combobox', { name: 'Filter by status' });
    fireEvent.change(status, { target: { value: 'awaiting_approval' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(status, { target: { value: 'All' } });

    const severity = screen.getByRole('combobox', { name: 'Filter by severity' });
    fireEvent.change(severity, { target: { value: 'Untriaged' } });
    expect(within(rows()[0]!).getByText('Fresh error')).toBeTruthy();
    fireEvent.change(severity, { target: { value: 'critical' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(status, { target: { value: 'killed' } });
    expect(screen.getByText('No incidents match your filters.')).toBeTruthy();
    expect(screen.getByLabelText('0 incidents')).toBeTruthy();
  });

  it('says so when there are no incidents yet', () => {
    renderPage([]);

    expect(screen.getByText('No incidents yet. They appear here as errors arrive.')).toBeTruthy();
  });

  it('updates a row from an issue.updated event, without a reload', () => {
    const source = renderPage();
    const target = issues[3]!;

    source.send({
      v: 1,
      issue: {
        ...target,
        status: 'triaged',
        class: 'database',
        severity: 'high',
        occurrences: 7,
        updatedAt: '2026-11-22T10:00:00.000Z',
      },
    });

    const row = within(rowOf(target.id));
    expect(row.getByText('Triaged')).toBeTruthy();
    expect(row.getByText('Database')).toBeTruthy();
    expect(row.getByText('High')).toBeTruthy();
    expect(row.getByText('7')).toBeTruthy();
    expect(rows()).toHaveLength(4);
    expect(metric('Open Incidents').getByText('3')).toBeTruthy();
  });

  it('adds a row for a new issue at the top', () => {
    const source = renderPage();
    const fresh = issue(9, { title: 'Brand new error', updatedAt: '2026-11-22T11:00:00.000Z' });

    source.send({ v: 1, issue: fresh });

    expect(rows()[0]!.getAttribute('data-issue-id')).toBe(fresh.id);
    expect(screen.getByLabelText('5 incidents')).toBeTruthy();
  });

  it('keeps the newer copy when an older event arrives late', () => {
    const source = renderPage();
    const target = issues[0]!;

    source.send({
      v: 1,
      issue: { ...target, status: 'killed', updatedAt: '2026-01-01T00:00:00.000Z' },
    });

    expect(within(rowOf(target.id)).getByText('Fixing')).toBeTruthy();
  });

  it('drops an event that breaks the contract', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = renderPage();

    source.send({ v: 2, issue: { ...issues[0]!, status: 'killed' } });
    source.send({ v: 1, issue: { ...issues[0]!, status: 'done' } });

    expect(within(rowOf(issues[0]!.id)).getByText('Fixing')).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('asks for the token when the orchestrator needs one', () => {
    renderWithIssues(<IncidentsPage />, testSource([], 'needs_token'));

    expect(screen.getByLabelText('Personal or API token')).toBeTruthy();
    expect(screen.getByText('Connect with the API token to load incidents.')).toBeTruthy();
  });

  it('tints severity and status badges with Radix steps, which follow the theme', () => {
    renderPage();

    const row = within(rowOf(issues[0]!.id));
    expect(row.getByText('Critical').className).toContain('bg-red-a3');
    expect(row.getByText('Fixing').className).toContain('bg-violet-a3');
  });
});
