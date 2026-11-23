import type { BugClass, Severity } from '@page/contracts';

export interface Verdict {
  class: BugClass;
  severity: Severity;
}

/** What triage reads: the issue's title and the report ingest stored, if it has one. */
export interface TriageInput {
  title: string;
  report: string | null;
}

interface Request {
  path: string;
  /** Next's route type: `render`, `route`, `action`. Missing for a browser error. */
  source: string | undefined;
}

/** The parts of a report (src/ingest/report.ts) the rules read. */
interface Parsed {
  request: Request | null;
  /** The file of each frame, innermost first. */
  frames: string[];
  /** The title and every exception message line. */
  message: string;
}

// `GET /products/[redacted] (route /products/[slug], render)`, the report's first line when the
// event had a request, followed by a blank line. A browser error starts `Request to`.
const REQUEST = /^(?:[A-Z]+|Request to) (\S+)(?: \((.*)\))?$/;
const FRAME = /^\s+at (.*)$/;
const COMPILED_NOTE = /^\s+\(these frames are compiled/;

function parseRequest(line: string): Request | null {
  const match = REQUEST.exec(line);
  if (!match) return null;
  const notes = (match[2] ?? '').split(', ').filter((note) => note && !note.startsWith('route '));
  return { path: match[1] ?? '', source: notes[0] };
}

/** `getCart (apps/demo-app/src/shop/cart.ts:43:9)` or `apps/x.ts:1:13` to its file. */
function frameFile(at: string): string {
  const open = at.lastIndexOf(' (');
  const location = at.endsWith(')') && open !== -1 ? at.slice(open + 2, -1) : at;
  return location.replace(/(?::\d+){1,2}$/, '');
}

function parse({ title, report }: TriageInput): Parsed {
  const lines = (report ?? '').split('\n');
  const request = lines[1] === '' ? parseRequest(lines[0] ?? '') : null;
  const frames: string[] = [];
  const message = [title];
  for (const line of request ? lines.slice(2) : lines) {
    const frame = FRAME.exec(line);
    if (frame) frames.push(frameFile(frame[1] ?? ''));
    else if (!COMPILED_NOTE.test(line)) message.push(line);
  }
  return { request, frames, message: message.join('\n') };
}

const INFRA_TEXT =
  /econnrefused|eaddrinuse|enotfound|etimedout|enoent|config|environment variable|missing env/i;
// An env var's name, such as FREE_SHIPPING_MIN_CENTS in a settings schema's error. Node's
// error codes (ERR_INVALID_URL) look the same, so they don't count.
const ENV_NAME = /\b(?!ERR_)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const CONFIG_FRAME = /(?:^|\/)(?:config|env|settings)(?:\.[cm]?[jt]sx?$|\/)/i;
const DATABASE_TEXT =
  /relation|postgres|sql|column|constraint|duplicate key|operator does not exist|syntax error at or near|deadlock detected/i;
const SQL_FRAME = /(?:^|\/)migrations?\/|\.sql$/;
// node-postgres names a server error `error`, so its issue title starts `error: `.
const PG_ERROR = /^error: /;
const FRONTEND_TEXT =
  /react|hydration|window is not defined|document is not defined|next\/image|\.tsx\b/i;
// A component file, or a browser bundle chunk.
const FRONTEND_FRAME = /\.[jt]sx$|\/static\/chunks\//;
// Postgres rejecting a value: `value "3000000000" is out of range for type integer` or
// `invalid input syntax for type uuid: "42"`.
const OUT_OF_RANGE = /value "([^"\n]*)" is out of range for type/;
const INVALID_INPUT = /invalid input syntax for type [\w ]+: "(.*)"/;
const ARRAY_LITERAL = /^\{.*\}$/;

/** A page render, a server action or a browser error, not an API route. */
function isPage({ path, source }: Request): boolean {
  if (source === 'render' || source === 'action') return true;
  if (source === 'route') return false;
  return !/^\/api(?:\/|$)/.test(path);
}

/** Whether `value` is one of the request path's segments, so the request sent it. */
function sentIn(value: string, path: string): boolean {
  return value !== '' && path.split(/[/?&=]/).includes(value);
}

/**
 * Where a value Postgres rejected came from. One the request sent means the code that read
 * the request didn't check it, so the bug is in that page or route. A number too big for its
 * column that the request didn't send came from the server's own state, which in this app is
 * a setting (scenarios 029 and 030). An array literal where Postgres wanted a scalar is a
 * query that binds its parameters wrongly. Any other bad value came from the app's code.
 */
function rejectedValue({ request, message }: Parsed): BugClass | null {
  const outOfRange = OUT_OF_RANGE.exec(message)?.[1];
  const invalid = INVALID_INPUT.exec(message)?.[1];
  const value = outOfRange ?? invalid;
  if (value === undefined) return null;
  if (request && sentIn(value, request.path)) return isPage(request) ? 'frontend' : 'backend-api';
  if (outOfRange !== undefined) return 'infra-config';
  return ARRAY_LITERAL.test(value) ? 'database' : 'backend-api';
}

function classOf(input: TriageInput): BugClass {
  const parsed = parse(input);
  const { request, frames, message } = parsed;
  if (
    INFRA_TEXT.test(message) ||
    ENV_NAME.test(message) ||
    frames.some((file) => CONFIG_FRAME.test(file))
  ) {
    return 'infra-config';
  }
  const rejected = rejectedValue(parsed);
  if (rejected) return rejected;
  if (
    DATABASE_TEXT.test(message) ||
    PG_ERROR.test(input.title) ||
    frames.some((file) => SQL_FRAME.test(file))
  ) {
    return 'database';
  }
  if (
    FRONTEND_TEXT.test(message) ||
    frames.some((file) => FRONTEND_FRAME.test(file)) ||
    (request !== null && isPage(request))
  ) {
    return 'frontend';
  }
  return 'backend-api';
}

/**
 * Class and severity from keywords in the title and report, its frames and its request line.
 * The model falls back to these, so they need no network and always answer. The severity is
 * also the floor under the model's (classify.ts). A bad setting breaks every request that
 * reads it, so infra-config is high, not low: with a low floor, naming an env var in a report
 * would be enough to let the model page low.
 */
export function classifyByRules(input: TriageInput): Verdict {
  const klass = classOf(input);
  const text = `${input.title}\n${input.report ?? ''}`;
  let severity: Severity = 'high';
  if (klass === 'database' || /fatal|payment|checkout/i.test(text)) severity = 'critical';
  else if (klass === 'frontend') severity = 'medium';
  return { class: klass, severity };
}
