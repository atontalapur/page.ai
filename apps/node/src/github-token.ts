import { gitHubTokenSchema } from '@page/contracts';
import type { Logger } from 'pino';

// A token with less than this left is fetched again.
const MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

export interface GitHubTokenOptions {
  orchestratorUrl: string;
  /** NODE_SHARED_SECRET, which the orchestrator's token route checks. */
  secret: string;
  /** A personal token from the env, used while no GitHub App is installed. */
  fallback: string | undefined;
  logger: Logger;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * The token the node pushes and opens PRs with: the GitHub App's installation token from
 * the orchestrator, which holds the app's key, kept until near its expiry. While no app is
 * installed (the orchestrator answers 404), GITHUB_TOKEN from the env.
 */
export function gitHubToken({
  orchestratorUrl,
  secret,
  fallback,
  logger,
  fetch: doFetch = (url, init) => fetch(url, init),
}: GitHubTokenOptions): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  let warned = false;
  return async () => {
    if (cached && cached.expiresAt - Date.now() > MARGIN_MS) return cached.token;
    const res = await doFetch(`${orchestratorUrl.replace(/\/$/, '')}/github/token`, {
      headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const body = gitHubTokenSchema.parse(await res.json());
      cached = { token: body.token, expiresAt: Date.parse(body.expiresAt) };
      return body.token;
    }
    if (res.status === 404 && fallback) {
      if (!warned) logger.warn('no GitHub App is installed; pushing with GITHUB_TOKEN');
      warned = true;
      return fallback;
    }
    throw new Error(
      res.status === 404
        ? 'no GitHub App is installed and GITHUB_TOKEN is unset; set up the app in Settings'
        : `the orchestrator answered ${res.status} for a GitHub token`,
    );
  };
}
