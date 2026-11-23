// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { DebugResult, DebugState } from '@page/contracts';

import DebuggingPage from './DebuggingPage';
import { renderWithIssues, testSource } from '../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const state: DebugState = {
  demoAppUrl: 'https://demo.example.com',
  healthy: true,
  overrides: [{ key: 'SHIPPING_FLAT_CENTS', value: '2500000000' }],
  codeBugLive: false,
  canSendSynthetic: true,
};

/** The orchestrator's /debug routes. Returns the requests the page made. */
function orchestrator(
  get: { status: number; body: unknown } = { status: 200, body: state },
  post: DebugResult = { ok: true, status: 500, message: 'The order failed with 500.' },
) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: RequestInit = {}) => {
      calls.push(
        `${init.method ?? 'GET'} ${path}${typeof init.body === 'string' ? ` ${init.body}` : ''}`,
      );
      return Promise.resolve(
        init.method === 'POST'
          ? Response.json(post)
          : Response.json(get.body, { status: get.status }),
      );
    }),
  );
  return calls;
}

const card = (title: string) =>
  within(
    screen
      .getByText(title, { selector: '[data-slot="card-title"]' })
      .closest('[data-slot="card"]') as HTMLElement,
  );

describe('DebuggingPage', () => {
  it("shows the demo app's state, and offers only the errors it can create now", async () => {
    orchestrator();
    renderWithIssues(<DebuggingPage />, testSource([]));

    expect(await screen.findByText('https://demo.example.com')).toBeTruthy();
    expect(screen.getByText('Healthy')).toBeTruthy();
    expect(screen.getByText('SHIPPING_FLAT_CENTS=2500000000')).toBeTruthy();

    const button = (title: string) =>
      card(title).getByRole<HTMLButtonElement>('button', { name: 'Create error' });
    expect(button('Break checkout').disabled).toBe(false);
    expect(button('Send a test exception').disabled).toBe(false);
    expect(button('Hit the code bug').disabled).toBe(true);
    expect(card('Hit the code bug').getByText(/No code bug is live/)).toBeTruthy();
  });

  it('creates an error and links to Incidents', async () => {
    const calls = orchestrator();
    renderWithIssues(<DebuggingPage />, testSource([]));

    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Create error' }))[0] as HTMLElement,
    );

    const result = await card('Break checkout').findByRole('status');
    expect(result.textContent).toContain('The order failed with 500.');
    expect(within(result).getByRole('link', { name: 'Watch it on Incidents' })).toBeTruthy();
    expect(calls).toContain('POST /debug/errors {"kind":"checkout"}');
  });

  it('resets the demo app', async () => {
    const calls = orchestrator(undefined, {
      ok: true,
      status: null,
      message: 'Cleared SHIPPING_FLAT_CENTS and restarted the demo app.',
    });
    renderWithIssues(<DebuggingPage />, testSource([]));

    fireEvent.click(await screen.findByRole('button', { name: 'Reset the demo app' }));

    expect(await screen.findByText(/Cleared SHIPPING_FLAT_CENTS/)).toBeTruthy();
    expect(calls).toContain('POST /debug/reset');
  });

  it('says when the orchestrator has the tools off', async () => {
    orchestrator({ status: 404, body: { message: 'Debugging tools are off.' } });
    renderWithIssues(<DebuggingPage />, testSource([]));

    expect(await screen.findByText('Debugging is off on this orchestrator')).toBeTruthy();
    expect(screen.getByText('Debugging tools are off.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create error' })).toBeNull();
  });
});
