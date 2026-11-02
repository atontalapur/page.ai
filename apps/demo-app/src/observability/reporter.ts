/** Where an error happened. Everything is optional because client errors know less. */
export interface ErrorContext {
  /** The route file path, e.g. `/products/[slug]`, so one bug groups across ids and slugs. */
  route?: string;
  /** The request path with its query, e.g. `/products/wool-beanie`. */
  path?: string;
  method?: string;
  /** Where Next caught it: render, route, action or proxy. `client` for the browser. */
  source?: string;
  /** React's digest for an error it replaced during Server Component rendering. */
  digest?: string;
}

export interface ErrorReporter {
  /** Never throws: a broken reporter mustn't turn one error into two. */
  captureException(error: unknown, context: ErrorContext): Promise<void>;
}

export interface CapturedError {
  error: unknown;
  properties: Record<string, string>;
}

/**
 * The name PostHog groups and titles the error by. React can hand `onRequestError` a
 * plain object or a string instead of the thrown Error, which would otherwise show up as
 * "Error" or "Unknown" and merge unrelated bugs.
 */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const { name } = error;
    if (typeof name === 'string' && name) return name;
  }
  return typeof error === 'string' ? 'StringError' : 'NonError';
}

/** Properties attached to every captured exception. Undefined context fields are left out. */
export function errorProperties(
  error: unknown,
  context: ErrorContext,
  release: string,
): Record<string, string> {
  const properties: Record<string, string> = { error_name: errorName(error), release };
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === 'string' && value) properties[key] = value;
  }
  return properties;
}

/** Records exceptions in memory. Used whenever POSTHOG_KEY is unset, so nothing hits the network. */
export class FakeErrorReporter implements ErrorReporter {
  readonly captured: CapturedError[] = [];

  private readonly release: string;

  constructor(release = 'dev') {
    this.release = release;
  }

  captureException(error: unknown, context: ErrorContext): Promise<void> {
    this.captured.push({ error, properties: errorProperties(error, context, this.release) });
    return Promise.resolve();
  }
}
