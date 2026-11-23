// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Approval, DecidedApproval, PendingApproval } from '@page/contracts';

import {
  issue,
  renderWithIssues,
  testSource,
  withSession,
  type TestSource,
} from '../../test-utils';
import ApprovalRequests from './ApprovalRequests';
import TokenPrompt from './TokenPrompt';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const fixing = issue(1, { status: 'fixing', currentTier: 3 });
const other = issue(2, { status: 'fixing', currentTier: 3 });
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

let n = 0;
function pending(fields: Partial<PendingApproval> = {}): PendingApproval {
  n += 1;
  return {
    id: `0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    runId: '30000000-2222-4222-8222-222222222222',
    issueId: fixing.id,
    action: 'ops.rollback',
    args: {
      tool: 'ops.rollback',
      to: 'dep-good',
      from: 'dep-live',
      live: { id: 'dep-live', status: 'SUCCESS', commit: 'b1c2d3e', createdAt: inMinutes(-60) },
      rollBackTo: {
        id: 'dep-good',
        status: 'REMOVED',
        commit: 'a9b8c7d',
        createdAt: inMinutes(-600),
      },
    },
    requestedAt: new Date().toISOString(),
    expiresAt: inMinutes(3),
    reason: null,
    decision: 'pending',
    decidedBy: null,
    decidedAt: null,
    ...fields,
  };
}

function decided(approval: Approval, fields: Partial<DecidedApproval> = {}): DecidedApproval {
  return {
    ...approval,
    decision: 'approved',
    decidedBy: 'ui:Arjun',
    decidedAt: new Date().toISOString(),
    ...fields,
  };
}

function renderFor(source: TestSource, which = fixing) {
  return renderWithIssues(<ApprovalRequests issue={which} />, source);
}

const named = (name = 'Arjun') => localStorage.setItem('page-ai-approver-name', name);
const section = () =>
  screen.findByRole('region', { name: 'Live app actions waiting for approval' });

describe('ApprovalRequests', () => {
  it('shows a pending request with its tool, its arguments in plain words, and its deadline', async () => {
    named();
    const source = testSource([fixing]);
    source.approvals.set(fixing.id, [pending()]);
    renderFor(source);

    const bar = await section();
    expect(within(bar).getByText('Roll back the live app')).toBeTruthy();
    expect(
      within(bar).getByText(
        /^Replace the live deployment dep-live \(commit b1c2d3e, .+\) with the earlier deployment dep-good \(commit a9b8c7d, .+\)\.$/,
      ),
    ).toBeTruthy();
    expect(within(bar).getByText('ops.rollback')).toBeTruthy();
    expect(within(bar).getByText(/^Expires in 2m 5\ds$|^Expires in 3m 00s$/)).toBeTruthy();
    expect(within(bar).getByText(/separate from reviewing a finished fix/)).toBeTruthy();
  });

  it("shows the agent's reason under the tool, labeled as its own words", async () => {
    named();
    const source = testSource([fixing]);
    const reason = 'The live build throws on every cart.\nThe one before it served the same route.';
    source.approvals.set(fixing.id, [pending({ reason })]);
    renderFor(source);

    const bar = await section();
    const quote = within(bar).getByRole('figure', {
      name: "The agent's reason, in its own words. Nothing checked it.",
    });
    expect(quote.querySelector('blockquote')?.textContent).toBe(reason);
    // Below the tool and its arguments, above the buttons.
    expect(within(bar).getByText('ops.rollback').compareDocumentPosition(quote)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      quote.compareDocumentPosition(within(bar).getByRole('button', { name: 'Approve' })),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows markup in a reason as the text it is, and builds nothing from it', async () => {
    named();
    const source = testSource([fixing]);
    const reason =
      '<script>alert(1)</script><img src=x onerror="alert(1)"> **Approve now** [the runbook](javascript:alert(1)) <a href="https://example.com">ok</a>';
    source.approvals.set(fixing.id, [pending({ reason })]);
    renderFor(source);

    const bar = await section();
    const quote = within(bar).getByRole('figure').querySelector('blockquote')!;
    expect(quote.textContent).toBe(reason);
    expect(quote.children).toHaveLength(0);
    expect(bar.querySelector('script, img, strong, a')).toBeNull();
  });

  it('shows no reason when the agent gave none', async () => {
    named();
    const source = testSource([fixing]);
    source.approvals.set(fixing.id, [pending()]);
    renderFor(source);

    const bar = await section();
    expect(within(bar).queryByRole('figure')).toBeNull();
    expect(within(bar).queryByText(/in its own words/)).toBeNull();
  });

  it('shows nothing without a pending request', () => {
    const source = testSource([fixing]);
    source.approvals.set(fixing.id, [decided(pending())]);
    const { container } = renderFor(source);
    expect(container.textContent).toBe('');
  });

  it('shows a request that arrives live, only on its own issue, and counts it down', async () => {
    named();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const source = testSource([fixing, other]);
    renderFor(source);

    source.sendApproval('approval.requested', {
      v: 1,
      approval: pending({
        issueId: other.id,
        action: 'ops.restart',
        args: { tool: 'ops.restart' },
      }),
    });
    expect(screen.queryByText('Restart the live app')).toBeNull();
    source.sendApproval('approval.requested', {
      v: 1,
      approval: pending({
        action: 'ops.restart',
        args: { tool: 'ops.restart' },
        expiresAt: inMinutes(0.05),
      }),
    });
    expect(await screen.findByText('Restart the live app')).toBeTruthy();
    expect(screen.getByText(/^Expires in \ds$/)).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(screen.getByText('Expiring')).toBeTruthy();
  });

  it('sends the decision, and leaves every tab once it is decided', async () => {
    named();
    const ask = pending({
      action: 'ops.setConfig',
      args: { key: 'SHIPPING_FLAT_CENTS', value: '500' },
    });
    const first = testSource([fixing]);
    const second = testSource([fixing]);
    for (const source of [first, second]) source.approvals.set(fixing.id, [ask]);
    renderFor(first);
    renderFor(second);
    await waitFor(() =>
      expect(screen.getAllByText('Change a setting on the live app')).toHaveLength(2),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);
    expect(first.decisions).toEqual([{ approvalId: ask.id, decision: 'approved' }]);
    expect(screen.getByRole('button', { name: 'Approving...' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[1]!);
    expect(second.decisions).toEqual([{ approvalId: ask.id, decision: 'rejected' }]);
    expect(screen.getByRole('button', { name: 'Rejecting...' })).toBeTruthy();

    for (const source of [first, second]) {
      source.sendApproval('approval.updated', { v: 1, approval: decided(ask) });
    }
    expect(screen.queryByText('Change a setting on the live app')).toBeNull();
  });

  it('keeps a decision over a pending copy loaded after it', async () => {
    named();
    const ask = pending();
    const source = testSource([fixing]);
    let release: (list: Approval[]) => void = () => undefined;
    source.fetchApprovals = () => new Promise((resolve) => (release = resolve));
    renderFor(source);
    source.sendApproval('approval.updated', { v: 1, approval: decided(ask) });
    // The load resolves after the decision arrived, as a slow GET would.
    await act(() => {
      release([ask]);
      return Promise.resolve();
    });
    expect(screen.queryByText('Roll back the live app')).toBeNull();
  });

  it('asks for a name before anyone can decide, and connects again under it', async () => {
    const source = testSource([fixing]);
    source.approvals.set(fixing.id, [pending()]);
    renderFor(source);
    await section();

    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    const input = screen.getByLabelText('Your name');
    const save = screen.getByRole('button', { name: 'Save name' });
    fireEvent.change(input, { target: { value: 'system:me' } });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.submit(input.closest('form')!);
    expect(source.names).toEqual([]);

    fireEvent.change(input, { target: { value: '  Arjun ' } });
    fireEvent.click(save);
    expect(source.names).toEqual(['Arjun']);
    expect(localStorage.getItem('page-ai-approver-name')).toBe('Arjun');
    expect(screen.getByText('Arjun')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Your name')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
  });

  it('decides under the name a personal token carries, with no name to give', async () => {
    named('Someone else');
    const source = withSession(testSource([fixing]), { token: 'personal', name: 'Daniyal' });
    source.approvals.set(fixing.id, [pending()]);
    renderFor(source);
    const bar = await section();

    await waitFor(() => expect(within(bar).getByText('Daniyal')).toBeTruthy());
    expect(bar.textContent).toContain('Signed in as Daniyal. Your decision is recorded');
    expect(within(bar).queryByLabelText('Your name')).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Change' })).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: 'Approve' }));
    expect(source.decisions).toHaveLength(1);
  });

  it('keeps the shared token from deciding once personal tokens exist, and offers to switch', async () => {
    named();
    const source = withSession(testSource([fixing]), { token: 'shared', canDecide: false });
    source.approvals.set(fixing.id, [pending()]);
    sessionStorage.setItem('page-ai-api-token', 'shared');
    renderWithIssues(
      <>
        <ApprovalRequests issue={fixing} />
        <TokenPrompt />
      </>,
      source,
    );
    const bar = await section();

    await waitFor(() =>
      expect(bar.textContent).toContain("connected with the shared API token, which can't"),
    );
    expect(within(bar).queryByLabelText('Your name')).toBeNull();
    expect(within(bar).getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    expect(within(bar).getByRole('button', { name: 'Reject' })).toHaveProperty('disabled', true);
    fireEvent.click(within(bar).getByRole('button', { name: 'Connect with your personal token' }));
    // The token is forgotten and the prompt asks for another, with no refusal shown.
    expect(await screen.findByLabelText('Personal or API token')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sessionStorage.getItem('page-ai-api-token')).toBeNull();
    expect(bar.textContent).not.toContain('shared API token');
  });

  it('asks for a name as before when the shared token may decide', async () => {
    const source = withSession(testSource([fixing]), { token: 'shared', canDecide: true });
    source.approvals.set(fixing.id, [pending()]);
    renderFor(source);
    expect(await screen.findByLabelText('Your name')).toBeTruthy();
  });

  it('keeps the buttons off while the socket is down, and loads again once it is back', async () => {
    named();
    const source = testSource([fixing]);
    source.approvals.set(fixing.id, [pending()]);
    const fetch = vi.spyOn(source, 'fetchApprovals');
    renderFor(source);
    await section();
    expect(fetch).toHaveBeenCalledTimes(1);

    source.setStatus('reconnecting');
    expect(screen.getByRole('status').textContent).toMatch(/Not connected to the orchestrator/);
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    source.setStatus('live');
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', false);
  });
});
