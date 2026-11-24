import type { PosthogWebhook } from '../webhook.ts';

// A scenario's report (scenarios/<id>/meta.json) turned back into the `$exception` webhook the
// demo app's error would send. The orchestrator's triage tests read what ingest stores for it,
// and the end-to-end test's fake target (eval/src/e2e-fake.ts) sends it to the orchestrator.

/**
 * `source`: frames name the app's files, as a dev server's or a symbolicated event's do.
 * `compiled`: frames name .next/server chunks with no function names, as staging's production
 * build sends them without source maps in PostHog.
 */
export type FrameShape = 'source' | 'compiled';

interface Frame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

interface Exception {
  type: string;
  value: string;
  frames: Frame[];
}

// The demo app's routes, as Next names them in onRequestError's `routePath`.
const ROUTES = [
  '/',
  '/cart',
  '/orders/[id]',
  '/products/[slug]',
  '/api/cart',
  '/api/cart/items',
  '/api/orders',
  '/api/products',
  '/api/products/[slug]',
];

function routeOf(path: string): string {
  const segments = (path.split('?')[0] ?? '').split('/');
  const route = ROUTES.find((candidate) => {
    const parts = candidate.split('/');
    return (
      parts.length === segments.length &&
      parts.every((part, i) => part === segments[i] || part.startsWith('['))
    );
  });
  if (!route) throw new Error(`no demo app route for ${path}`);
  return route;
}

// `at fn (file:line:col)`, `at file:line:col` or `at fn (<anonymous>)`, as V8 prints them.
// pg's error fields follow the last frame after ` {`.
const FRAME = /^\s+at (?:async )?(?:(.+) \()?([^\s()]+?)(?::(\d+):(\d+))?\)?(?: \{)?$/;
const CAUSE = /^\s*\[cause\]: (.*)$/;

function frameOf(line: string): Frame | null {
  const match = FRAME.exec(line);
  if (!match) return null;
  const [, name, file = '', lineno, colno] = match;
  const external =
    file.startsWith('node:') || file.includes('node_modules/') || file === '<anonymous>';
  return {
    ...(name === undefined ? {} : { function: name }),
    filename: file,
    ...(lineno === undefined ? {} : { lineno: Number(lineno), colno: Number(colno) }),
    in_app: !external,
  };
}

function exception(head: string): Exception {
  const colon = head.indexOf(': ');
  return colon === -1
    ? { type: head, value: '', frames: [] }
    : { type: head.slice(0, colon), value: head.slice(colon + 2), frames: [] };
}

/**
 * The exceptions a scenario report prints: the error with its message, which may run over
 * several lines (a ZodError's issues), its frames, and a `[cause]` with its own frames.
 * Lines that are neither (pg's error fields, a ShopError's code) are left out, as
 * posthog-node leaves them out of `$exception_list`.
 */
function exceptions(lines: string[]): Exception[] {
  const firstFrame = lines.findIndex((line) => frameOf(line) !== null);
  const head = firstFrame === -1 ? lines : lines.slice(0, firstFrame);
  const list = [exception(head.join('\n'))];
  for (const line of firstFrame === -1 ? [] : lines.slice(firstFrame)) {
    const cause = CAUSE.exec(line);
    if (cause) list.push(exception(cause[1] ?? ''));
    const frame = frameOf(line);
    if (frame) list.at(-1)?.frames.push(frame);
  }
  return list;
}

// Turbopack puts the server side of pages under chunks/ssr and route handlers under chunks.
function compiled(frames: Frame[], api: boolean): Frame[] {
  const chunk = `/app/.next/server/chunks/${api ? '' : 'ssr/'}[root-of-the-server]__0q8x1m._.js`;
  return frames.map((frame, i) =>
    frame.in_app ? { filename: chunk, lineno: 1, colno: 1000 + i, in_app: true } : frame,
  );
}

/**
 * The `$exception` webhook for a scenario's report, on top of `base` (its uuid, timestamp and
 * PostHog issue id).
 */
export function webhookFor(
  report: string,
  shape: FrameShape,
  base: PosthogWebhook,
): PosthogWebhook {
  const [requestLine = '', ...rest] = report.split('\n');
  const request = /^([A-Z]+) (\S+) returned \d{3}$/.exec(requestLine);
  if (!request) throw new Error(`no request line in ${requestLine}`);
  const [, method = '', path = ''] = request;
  // Request body, cookie, header and form lines come before the blank line. The demo app
  // sends none of them to PostHog.
  const list = exceptions(rest.slice(rest.indexOf('') + 1));
  const api = path.startsWith('/api/');
  return {
    ...base,
    event: {
      ...base.event,
      properties: {
        ...base.event.properties,
        $exception_types: list.slice(0, 1).map((e) => e.type),
        $exception_values: list.slice(0, 1).map((e) => e.value),
        $exception_list: list.map((e) => ({
          type: e.type,
          value: e.value,
          // PostHog lists frames outermost first; V8 prints them innermost first.
          stacktrace: {
            type: 'raw',
            frames: [...(shape === 'compiled' ? compiled(e.frames, api) : e.frames)].reverse(),
          },
        })),
        method,
        path,
        route: routeOf(path),
        source: api ? 'route' : method === 'GET' ? 'render' : 'action',
      },
    },
  };
}
