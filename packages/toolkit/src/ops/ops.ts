// The live demo app's ops API (#13, apps/demo-app/src/ops/api.ts), as the Tier 3 host tools
// call it. Settings changes are runtime_config overrides, read once per process, so they
// take effect on the next restart.

/** What the app answered: the status and the JSON body, or the text when it isn't JSON. */
export interface OpsReply {
  status: number;
  body: unknown;
}

/** A restart's answer and, once the app accepted it, whether the app came back. */
export interface RestartReply extends OpsReply {
  /** Set after a 202: whether /api/health answered 200 before the wait ran out. */
  healthy?: { ok: boolean; afterMs: number };
}

/** The ops API couldn't be reached at all. An error status is an OpsReply, not this. */
export class OpsError extends Error {
  override name = 'OpsError';
}

/**
 * The demo app's ops API, or a fake. Every method resolves for any HTTP status and rejects
 * only when the app can't be reached or `signal` fires.
 */
export interface OpsApi {
  getConfig(signal?: AbortSignal): Promise<OpsReply>;
  setConfig(key: string, value: string, signal?: AbortSignal): Promise<OpsReply>;
  deleteConfig(key: string, signal?: AbortSignal): Promise<OpsReply>;
  /** Asks for a restart and, if the app accepts it, waits for it to answer /api/health. */
  restart(signal?: AbortSignal): Promise<RestartReply>;
}

/** Shop setting names are UPPER_SNAKE_CASE. Anything else is refused before it reaches a URL. */
export const SETTING_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
