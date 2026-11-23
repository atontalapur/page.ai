// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';

import IncidentDetailsPage from './IncidentDetailsPage';
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

  it('keeps a placeholder for agent runs', () => {
    renderDetails(fixing.id);

    expect(screen.getByText('Agent Runs')).toBeTruthy();
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
