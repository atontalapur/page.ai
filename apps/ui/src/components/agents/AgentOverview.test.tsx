// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NodeSummary } from '@page/contracts';

import AgentOverview from './AgentOverview';
import { daemon, issue, nodeRun } from '../../test-utils';

const fixing = issue(1, { title: 'TypeError: price is undefined' });

const agents: NodeSummary[] = [
  daemon('offline-node', { connected: false }),
  daemon('idle-a'),
  daemon('busy-node', { current: [nodeRun(1, fixing, { tier: 2 })] }),
  daemon('idle-b'),
];

afterEach(() => {
  cleanup();
});

function renderOverview(list: NodeSummary[] = agents) {
  return render(
    <MemoryRouter>
      <AgentOverview agents={list} />
    </MemoryRouter>,
  );
}

describe('AgentOverview', () => {
  it('counts running, idle and offline daemons', () => {
    renderOverview();

    expect(screen.getByText('4 node daemons')).toBeTruthy();
    expect(within(screen.getByTestId('running-count')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('idle-count')).getByText('2')).toBeTruthy();
    expect(within(screen.getByTestId('offline-count')).getByText('1')).toBeTruthy();
  });

  it('lists the three most active, running first, with what each is doing', () => {
    renderOverview();

    const names = screen.getAllByRole('link').map((link) => link.textContent);
    expect(names).toEqual(['busy-node', 'idle-a', 'idle-b']);
    expect(screen.getByRole('link', { name: 'busy-node' }).getAttribute('href')).toBe(
      '/agents/busy-node',
    );
    expect(screen.getByText('Tier 2 on TypeError: price is undefined')).toBeTruthy();
    expect(screen.getAllByText('Waiting for a fix job')).toHaveLength(2);
    expect(screen.queryByText('offline-node')).toBeNull();
  });

  it('says what an offline daemon is doing, and colours each status', () => {
    renderOverview([daemon('offline-node', { connected: false }), agents[2]!]);

    expect(screen.getByText('Not connected')).toBeTruthy();
    const badges = Array.from(document.querySelectorAll('[data-slot="badge"]'));
    expect(badges.map((badge) => [badge.textContent, badge.className.includes('-a3')])).toEqual([
      ['Running', true],
      ['Offline', true],
    ]);
  });

  it('handles no daemons', () => {
    renderOverview([]);

    expect(screen.getByText('0 node daemons')).toBeTruthy();
    expect(screen.getByText('No node daemon has connected yet.')).toBeTruthy();
  });

  it('names a single daemon in the singular', () => {
    renderOverview([daemon('only-node')]);
    expect(screen.getByText('1 node daemon')).toBeTruthy();
  });
});
