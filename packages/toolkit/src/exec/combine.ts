import type { Tier } from '@page/contracts';
import type { HostToolName, HostTools } from './types.ts';

/**
 * One HostTools over several, such as the GitHub tools and the ops tools: each call goes to
 * the first part that handles its tool. A part without `handles` takes every tool, so put it
 * last. execute() refuses a tool no part handles.
 */
export function combineHostTools(...parts: HostTools[]): HostTools {
  const owner = (tool: HostToolName) => parts.find((part) => part.handles?.(tool) ?? true);
  return {
    handles: (tool) => owner(tool) !== undefined,
    refusal: (call) => owner(call.tool)?.refusal?.(call) ?? null,
    run: (call, timeoutMs) => {
      const part = owner(call.tool);
      return part === undefined
        ? Promise.resolve({ ok: false, output: `${call.tool} is not set up on this node` })
        : part.run(call, timeoutMs);
    },
  };
}

/**
 * The host tools one run gets at `tier`: the knowledge tools at every tier, the GitHub tools
 * from Tier 2 and the ops tools from
 * Tier 3, combined. The daemon and the eval both build a run's host tools with it, so the
 * eval measures what the daemon runs. execute() still refuses each tool below its tier.
 */
export function hostToolsFor(
  tier: Tier,
  {
    github,
    ops,
    knowledge,
  }: {
    github?: HostTools | undefined;
    ops?: HostTools | undefined;
    knowledge?: HostTools | undefined;
  },
): HostTools | undefined {
  const parts = [knowledge, tier >= 2 ? github : undefined, tier >= 3 ? ops : undefined].filter(
    (part): part is HostTools => part !== undefined,
  );
  return parts.length === 0 ? undefined : combineHostTools(...parts);
}
