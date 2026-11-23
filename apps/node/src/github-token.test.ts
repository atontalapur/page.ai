import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { gitHubToken } from './github-token.ts';

const logger = pino({ enabled: false });

function orchestrator(status: number, expiresInMs = 3600_000) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch = (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    return Promise.resolve(
      status === 200
        ? Response.json({
            token: `ghs_${calls.length}`,
            repo: 'o/r',
            expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
          })
        : Response.json({ message: 'no app' }, { status }),
    );
  };
  return { calls, fetch };
}

describe('gitHubToken', () => {
  it("uses the app's installation token, with the node secret, until near its expiry", async () => {
    const { calls, fetch } = orchestrator(200);
    const token = gitHubToken({
      orchestratorUrl: 'https://o.example.com/',
      secret: 's',
      fallback: 'pat',
      logger,
      fetch,
    });
    expect(await token()).toBe('ghs_1');
    expect(await token()).toBe('ghs_1');
    expect(calls).toEqual([{ url: 'https://o.example.com/github/token', auth: 'Bearer s' }]);
  });

  it('fetches again when the token is about to expire', async () => {
    const { fetch } = orchestrator(200, 60_000);
    const token = gitHubToken({
      orchestratorUrl: 'https://o',
      secret: 's',
      fallback: undefined,
      logger,
      fetch,
    });
    expect(await token()).toBe('ghs_1');
    expect(await token()).toBe('ghs_2');
  });

  it('falls back to GITHUB_TOKEN while no app is installed, and fails without one', async () => {
    const { fetch } = orchestrator(404);
    expect(
      await gitHubToken({
        orchestratorUrl: 'https://o',
        secret: 's',
        fallback: 'pat',
        logger,
        fetch,
      })(),
    ).toBe('pat');
    await expect(
      gitHubToken({
        orchestratorUrl: 'https://o',
        secret: 's',
        fallback: undefined,
        logger,
        fetch,
      })(),
    ).rejects.toThrow(/Settings/);
  });
});
