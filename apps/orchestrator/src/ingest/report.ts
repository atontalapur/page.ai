import type { PosthogWebhook } from '@page/contracts';
import { z } from 'zod';

// The error report a fix job carries (#136), built once at ingest from the PostHog webhook.
// A Tier 2 run writes a public PR from it (docs/demo-repo.md), so it keeps only the request
// line, the exception and its in-app frames. Bodies, headers, cookies, person and other user
// fields are never read. Query values, path segments that look like a token or an id, and
// email addresses are masked, since any of them can hold user data. So is the input a
// JSON.parse error quotes, which is often a body.

// The agent's view of the error stays under 2,000 characters (#12), the same cap a scenario's
// report has in scenarioMetaSchema. A message gets a quarter of that, so frames still fit.
export const REPORT_MAX = 2_000;
export const MESSAGE_MAX = 500;
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

// `%40` too, for an encoded path that does not decode. The local part stops at 64, the most an
// address allows: unbounded, a long run of word characters with no `@` after it backtracks
// quadratically, and this runs on the whole message before the clip.
const EMAIL = /[\w.+-]{1,64}(?:@|%40)[\w-]+(?:\.[\w-]+)+/gi;

/** Masks email addresses, the user field most likely to land in a path or message. */
export function maskEmails(text: string): string {
  return text.replaceAll(EMAIL, '[email]');
}

// A JSON.parse error quotes part of its input, which is often a request body. V8 quotes up
// to about 20 characters (`Unexpected token 'c', "card=4242"... is not valid JSON`), or the
// whole input when it is short (`"undefined" is not valid JSON`). Safari quotes the bad token
// (`JSON Parse error: Unexpected identifier "card"`). The V8 pattern starts where V8 puts the
// quote, after the token or at the start of the message or a `: `, so quoted text earlier in
// a wrapping message stays. The input itself can hold quotes. The bounds keep the patterns
// linear on a long message.
const V8_JSON_INPUT =
  /(Unexpected token '[\s\S]{1,2}', |^|: )(?:\.\.\.)?"[\s\S]{0,64}?"(?:\.\.\.)? is not valid JSON/g;
const SAFARI_JSON_INPUT = /(JSON Parse error: [^"\n]{0,100})"[^"]{0,200}"/g;

/** An exception message with emails and quoted JSON input masked. */
export function maskMessage(text: string): string {
  return maskEmails(
    text
      .replaceAll(V8_JSON_INPUT, '$1"[input]" is not valid JSON')
      .replaceAll(SAFARI_JSON_INPUT, '$1"[input]"'),
  );
}

/** `text` with percent escapes decoded, or as it is when they are malformed. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Masks emails in a URL part, encoded ones too. A part with none stays as it was sent. */
function maskUrlEmails(part: string): string {
  const plain = decoded(part);
  const masked = maskEmails(plain);
  return masked === plain ? part : masked;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`;

/**
 * A path with each query value replaced, so `/search?q=me@x.com` becomes `/search?q=`.
 * The parameter names stay: they tell the agent which input took the request down. A piece
 * with no `=` may be a bare token (`/reset?3f9a8b7c`), so it becomes `[redacted]`.
 */
export function redactQuery(pathWithQuery: string): string {
  const [beforeHash = ''] = pathWithQuery.split('#', 1);
  const at = beforeHash.indexOf('?');
  const path = maskUrlEmails(at === -1 ? beforeHash : beforeHash.slice(0, at));
  if (at === -1) return path;
  const pieces = beforeHash
    .slice(at + 1)
    .split('&')
    .flatMap((piece) => {
      const eq = piece.indexOf('=');
      if (eq === -1) return piece === '' ? [] : ['[redacted]'];
      return eq === 0 ? [] : [`${maskUrlEmails(piece.slice(0, eq))}=`];
    });
  return pieces.length === 0 ? path : `${path}?${pieces.join('&')}`;
}

// A path segment that may be a secret or a user's id: a uuid, or a run of 16 or more letters
// and digits with a digit in it (a reset or invite token, a card number). Slugs such as
// `wool-beanie-2024` stay.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RUN = /[a-z0-9]{16,}/gi;

const isTokenSegment = (segment: string) =>
  UUID.test(segment) || (segment.match(TOKEN_RUN) ?? []).some((run) => /\d/.test(run));

/**
 * A request path with query values and emails redacted (redactQuery), and each segment that
 * looks like a token or an id too, so `/reset-password/9f8e7d6c5b4a3f2e1d0c` becomes
 * `/reset-password/[redacted]`. Frame file paths skip this step, since a bundle chunk's hash
 * looks like a token; a frame that names a page URL gets it.
 */
export function redactRequestPath(pathWithQuery: string): string {
  const at = pathWithQuery.search(/[?#]/);
  const path = at === -1 ? pathWithQuery : pathWithQuery.slice(0, at);
  const rest = at === -1 ? '' : pathWithQuery.slice(at);
  const segments = path
    .split('/')
    .map((segment) => (isTokenSegment(segment) ? '[redacted]' : segment));
  return redactQuery(`${segments.join('/')}${rest}`);
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
  const request = `${method ?? 'Request to'} ${redactRequestPath(path)}`;
  return clip(notes.length === 0 ? request : `${request} (${notes.join(', ')})`, 300);
}

/**
 * Where a frame points, relative to the repo where possible: bundler and file prefixes and
 * leading `../` go, and an absolute deploy path is cut back to its `apps/` directory (not
 * one that only ends in `apps`, like `/srv/webapps`).
 */
export function framePath(raw: string): string {
  let path = raw.replace(/^(webpack|file|turbopack):\/\/+(\[project\]\/)?/, '');
  const apps = path.search(/(?<=\/)apps\//);
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
  // A browser frame from an inline script names the page URL, query string and all.
  const file = framePath(raw);
  const path = /^https?:\/\//i.test(file) ? redactRequestPath(file) : redactQuery(file);
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

/**
 * The report for an error known only by its issue title: an event with no `$exception_list`,
 * or an issue opened without a report (POST /issues, or before migration 004).
 */
export function titleReport(title: string): string {
  // Masked before the clip, so a cut can't leave part of an email or the input behind.
  return clip(maskMessage(title), MESSAGE_MAX);
}

function exceptionLines(props: Record<string, unknown>, title: string): string[] {
  const list = z.array(z.unknown()).safeParse(props.$exception_list);
  const exceptions = (list.success ? list.data : [])
    .map((value) => exceptionSchema.safeParse(value))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .slice(0, EXCEPTIONS_MAX);
  if (exceptions.length === 0) return [titleReport(title)];

  const lines: string[] = [];
  exceptions.forEach((exception, index) => {
    const head = [str(exception.type), str(exception.value)].filter(Boolean).join(': ');
    const message = clip(maskMessage(head || 'Exception'), MESSAGE_MAX);
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
  return fit(request === null ? lines : [request, '', ...lines], REPORT_MAX);
}

/**
 * Drops whole lines from the end until the report fits, so the outermost frames and causes
 * go first and no frame is cut in half. The request line (300) and a message (500) can't fill
 * the cap alone; the clip is a backstop.
 */
function fit(lines: string[], max: number): string {
  const kept = [...lines];
  while (kept.length > 1 && kept.join('\n').length > max) kept.pop();
  return clip(kept.join('\n'), max);
}
