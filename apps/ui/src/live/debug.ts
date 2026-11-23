import {
  debugResultSchema,
  debugStateSchema,
  type DebugErrorKind,
  type DebugResult,
  type DebugState,
} from '@page/contracts';

import { readToken } from './token';

/** What GET /debug can say: the app's state, the tools are off, or it couldn't be read. */
export type DebugLoad =
  | { kind: 'state'; state: DebugState }
  | { kind: 'off'; message: string }
  | { kind: 'error'; message: string };

const headers = () => ({
  authorization: `Bearer ${readToken() ?? ''}`,
  accept: 'application/json',
});

async function messageOf(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => undefined);
  if (
    typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    typeof body.message === 'string'
  ) {
    return body.message;
  }
  return `The orchestrator answered ${res.status}.`;
}

/** The staging demo app as the orchestrator sees it, for the Debugging page. */
export async function loadDebug(): Promise<DebugLoad> {
  try {
    const res = await fetch('/debug', { headers: headers() });
    if (res.status === 404) return { kind: 'off', message: await messageOf(res) };
    if (!res.ok) return { kind: 'error', message: await messageOf(res) };
    const state = debugStateSchema.safeParse(await res.json());
    return state.success
      ? { kind: 'state', state: state.data }
      : { kind: 'error', message: 'The orchestrator answered with a state this page cannot read.' };
  } catch {
    return { kind: 'error', message: 'Could not reach the orchestrator.' };
  }
}

async function post(path: string, body?: object): Promise<DebugResult> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...headers(), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) return { ok: false, status: res.status, message: await messageOf(res) };
  const result = debugResultSchema.safeParse(await res.json());
  return result.success
    ? result.data
    : {
        ok: false,
        status: null,
        message: 'The orchestrator answered with a result this page cannot read.',
      };
}

/** Creates one test error on the staging demo app. */
export const createDebugError = (kind: DebugErrorKind) => post('/debug/errors', { kind });

/** Clears the demo app's overrides and restarts it. */
export const resetDemoApp = () => post('/debug/reset');

/** Opens the PR that plants the gentle test bug on the demo repo. */
export const plantBug = () => post('/debug/plant');
