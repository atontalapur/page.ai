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
    run: (call, timeoutMs) => {
      const part = owner(call.tool);
      return part === undefined
        ? Promise.resolve({ ok: false, output: `${call.tool} is not set up on this node` })
        : part.run(call, timeoutMs);
    },
  };
}
