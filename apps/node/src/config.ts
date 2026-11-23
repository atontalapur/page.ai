import { hostname } from 'node:os';
import { nodeConfigSchema, toNodeName, type NodeConfig } from '@page/contracts';
import { err, ok, type Result } from '@page/toolkit';
import { z } from 'zod';

/**
 * What the agents page calls this daemon: NODE_NAME, or else the machine's hostname, made
 * into a valid name. A hostname changes with each Railway deploy, so set NODE_NAME there.
 */
export function nodeName(config: Pick<NodeConfig, 'NODE_NAME'>, host = hostname()): string {
  return config.NODE_NAME ?? toNodeName(host);
}

/** Parses the daemon's env once at boot. Every missing or bad var is in the one error. */
export function loadConfig(env: Record<string, string | undefined>): Result<NodeConfig, string> {
  const parsed = nodeConfigSchema.safeParse(env);
  if (parsed.success) return ok(parsed.data);
  return err(`invalid node daemon config:\n${z.prettifyError(parsed.error)}`);
}
