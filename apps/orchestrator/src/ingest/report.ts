import type { PosthogWebhook } from '@page/contracts';
import { z } from 'zod';

// The error report a fix job carries (#136), built once at ingest from the PostHog webhook.
// A Tier 2 run writes a public PR from it (docs/demo-repo.md), so it keeps only the request
// line, the exception and its in-app frames. Bodies, headers, cookies, person and other user
// fields are never read. Query values are dropped and email addresses masked, since either
// can hold user data.

export const REPORT_MAX = 8_000;
const MESSAGE_MAX = 2_000;
const FRAMES_MAX = 15;
const EXCEPTIONS_MAX = 3;

/**
 * One stack frame as PostHog sends it. After symbolication a frame has `source`, `line`,
 * `column` and `resolved_name`; a raw one from the SDK has `filename`, `lineno`, `colno`
 * and `function`. Everything is optional, so an unknown shape yields fewer frames, not a 400.
 */
const frameSchema = z.looseObject({
  in_app: z.boolean().optional(),
  source: z.string().optional(),
  filename: z.string().optional(),
  abs_path: z.string().optional(),
  line: z.number().optional(),
  lineno: z.number().optional(),
  column: z.number().optional(),
  colno: z.number().optional(),
  resolved_name: z.string().optional(),
  function: z.string().optional(),
});

const exceptionSchema = z.looseObject({
  type: z.string().optional(),
  value: z.string().optional(),
  stacktrace: z.looseObject({ frames: z.array(z.unknown()).optional() }).nullish(),
});

type Frame = z.infer<typeof frameSchema>;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Masks email addresses, the user field most likely to land in a path or message. */
export function maskEmails(text: string): string {
  return text.replaceAll(EMAIL, '[email]');
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`;

/**
 * A path with each query value replaced, so `/search?q=me@x.com` becomes `/search?q=`.
 * The parameter names stay: they tell the agent which input took the request down.
 */
export function redactQuery(pathWithQuery: string): string {
  const [beforeHash = ''] = pathWithQuery.split('#', 1);
  const at = beforeHash.indexOf('?');
  const hashless = at === -1 ? beforeHash : beforeHash.slice(0, at);
  if (at === -1) return maskEmails(hashless);
  const names = beforeHash
    .slice(at + 1)
    .split('&')
    .map((pair) => pair.split('=')[0] ?? '')
    .filter((name) => name !== '');
  const kept = names.length === 0 ? '' : `?${names.map((name) => `${name}=`).join('&')}`;
  return maskEmails(`${hashless}${kept}`);
}

/** The path of a browser error's `$current_url`, if it parses. */
function pathOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

/** `GET /products/wool-beanie (route /products/[slug], render)`, or null with no request. */
function requestLine(props: Record<string, unknown>): string | null {
  const method = str(props.method);
  const path = str(props.path) ?? pathOf(str(props.$current_url) ?? '');
  if (path === undefined) return null;
  const notes = [str(props.route) && `route ${str(props.route)}`, str(props.source)].filter(
    (note): note is string => !!note,
  );
  const request = `${method ?? 'Request to'} ${redactQuery(path)}`;
  return clip(notes.length === 0 ? request : `${request} (${notes.join(', ')})`, 300);
}

/**
 * Where a frame points, relative to the repo where possible: bundler and file prefixes and
 * leading `../` go, and an absolute deploy path is cut back to `apps/...`.
 */
export function framePath(raw: string): string {
  let path = raw.replace(/^(webpack|file|turbopack):\/\/+(\[project\]\/)?/, '');
  const apps = path.indexOf('apps/');
  if (apps > 0) path = path.slice(apps);
  return path.replace(/^(\.\.?\/)+/, '');
}

const isNoise = (path: string) =>
  path === '<anonymous>' ||
  path.includes('node_modules/') ||
  path.startsWith('node:') ||
  path.includes('[turbopack]_runtime');

function formatFrame(frame: Frame): string | null {
  const raw = frame.source ?? frame.filename ?? frame.abs_path;
  if (raw === undefined || frame.in_app !== true) return null;
  const path = framePath(raw);
  if (isNoise(path)) return null;
  const line = frame.line ?? frame.lineno;
  const column = frame.column ?? frame.colno;
  const where = [path, line, line === undefined ? undefined : column]
    .filter((part) => part !== undefined)
    .join(':');
  const name = frame.resolved_name ?? frame.function;
  return name === undefined || name === '?' ? `    at ${where}` : `    at ${name} (${where})`;
}

/** In-app frames, innermost first: PostHog lists them outermost first, as V8 runs them. */
function inAppFrames(frames: unknown[]): string[] {
  const lines: string[] = [];
  for (const value of [...frames].reverse()) {
    const frame = frameSchema.safeParse(value);
    if (!frame.success) continue;
    const line = formatFrame(frame.data);
    if (line !== null && lines.at(-1) !== line) lines.push(line);
    if (lines.length === FRAMES_MAX) break;
  }
  return lines;
}

// A production Next build bundles the app into .next/server chunks. Without source maps
// uploaded to PostHog, its frames name those chunks, not apps/demo-app/src.
const COMPILED_NOTE =
  '    (these frames are compiled .next/server chunks; find the source from the error and the request)';

function exceptionLines(props: Record<string, unknown>, title: string): string[] {
  const list = z.array(z.unknown()).safeParse(props.$exception_list);
  const exceptions = (list.success ? list.data : [])
    .map((value) => exceptionSchema.safeParse(value))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .slice(0, EXCEPTIONS_MAX);
  if (exceptions.length === 0) return [maskEmails(clip(title, MESSAGE_MAX))];

  const lines: string[] = [];
  exceptions.forEach((exception, index) => {
    const head = [str(exception.type), str(exception.value)].filter(Boolean).join(': ');
    const message = maskEmails(clip(head || 'Exception', MESSAGE_MAX));
    lines.push(index === 0 ? message : `Caused by: ${message}`);
    const frames = inAppFrames(exception.stacktrace?.frames ?? []);
    lines.push(...frames);
    if (frames.length > 0 && frames.every((frame) => frame.includes('.next/'))) {
      lines.push(COMPILED_NOTE);
    }
  });
  return lines;
}

/**
 * The sanitized report for a PostHog `$exception` webhook: the request line, a blank line,
 * then each exception with its in-app frames. `title` is the issue title, used when the
 * event carries no `$exception_list`.
 */
export function reportFrom(body: PosthogWebhook, title: string): string {
  const props = body.event.properties as Record<string, unknown>;
  const request = requestLine(props);
  const lines = exceptionLines(props, title);
  const report = request === null ? lines.join('\n') : [request, '', ...lines].join('\n');
  return clip(report, REPORT_MAX);
}
