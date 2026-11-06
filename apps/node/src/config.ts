import { nodeConfigSchema, type NodeConfig } from '@page/contracts';
import { err, ok, type Result } from '@page/toolkit';
import { z } from 'zod';

/** Parses the daemon's env once at boot. Every missing or bad var is in the one error. */
export function loadConfig(env: Record<string, string | undefined>): Result<NodeConfig, string> {
  const parsed = nodeConfigSchema.safeParse(env);
  if (parsed.success) return ok(parsed.data);
  return err(`invalid node daemon config:\n${z.prettifyError(parsed.error)}`);
}
