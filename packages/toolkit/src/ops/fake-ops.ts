import type { OpsApi, OpsReply, RestartReply } from './ops.ts';

/**
 * An in-memory ops API. Overrides apply on restart, as on the real app: `served` is what the
 * app runs with since its last restart. Every call is logged in `calls`.
 */
export class FakeOps implements OpsApi {
  readonly overrides: Map<string, string>;
  served: Record<string, string>;
  readonly calls: string[] = [];

  constructor(overrides: Record<string, string> = {}) {
    this.overrides = new Map(Object.entries(overrides));
    this.served = { ...overrides };
  }

  getConfig(): Promise<OpsReply> {
    this.calls.push('getConfig');
    return Promise.resolve({
      status: 200,
      body: { overrides: Object.fromEntries(this.overrides), served: this.served },
    });
  }

  setConfig(key: string, value: string): Promise<OpsReply> {
    this.calls.push(`setConfig ${key}=${value}`);
    return Promise.resolve(this.change(key, value));
  }

  deleteConfig(key: string): Promise<OpsReply> {
    this.calls.push(`deleteConfig ${key}`);
    return Promise.resolve(this.change(key, null));
  }

  restart(): Promise<RestartReply> {
    this.calls.push('restart');
    this.served = Object.fromEntries(this.overrides);
    return Promise.resolve({
      status: 202,
      body: { restarting: true },
      healthy: { ok: true, afterMs: 0 },
    });
  }

  private change(key: string, value: string | null): OpsReply {
    const from = this.overrides.get(key) ?? null;
    if (value === null) this.overrides.delete(key);
    else this.overrides.set(key, value);
    return { status: 200, body: { key, from, to: value, appliesOn: 'restart' } };
  }
}
