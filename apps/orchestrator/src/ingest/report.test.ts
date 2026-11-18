import type { PosthogWebhook } from '@page/contracts';
import { posthogWebhookFixture } from '@page/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { framePath, maskEmails, redactQuery, REPORT_MAX, reportFrom } from './report.ts';

const next = '../../node_modules/.pnpm/next@16.4.5/node_modules/next/dist/server/base-server.js';
const chunk = '.next/server/chunks/ssr/[root-of-the-server]__1kgn5yuyma91u._.js';

// Trimmed from a real `$exception` for bug 001 as PostHog resolved it: frames outermost first,
// the throw site last, and in-app frames pointing at compiled chunks.
const resolvedFrames = [
  { in_app: false, line: 1011, resolved_name: 'DevServer.handleRequestImpl', source: next },
  { in_app: true, line: 3049, resolved_name: 'doRender', source: '.next/server/chunks/ssr/a._.js' },
  {
    in_app: true,
    line: 1737,
    resolved_name: 'instantiateModule',
    source: '.next/server/chunks/ssr/[turbopack]_runtime.js',
  },
  { in_app: true, line: 336, resolved_name: 'module evaluation', source: chunk },
  { in_app: false, resolved_name: 'new NumberFormat', source: '<anonymous>' },
];

function webhook(properties: Record<string, unknown>): PosthogWebhook {
  return {
    ...posthogWebhookFixture,
    event: {
      ...posthogWebhookFixture.event,
      properties: { ...posthogWebhookFixture.event.properties, ...properties },
    },
  };
}

const title = 'RangeError: Invalid currency code : US';

describe('reportFrom', () => {
  it('keeps the request line, the exception and its in-app frames, innermost first', () => {
    const body = webhook({
      method: 'GET',
      path: '/',
      route: '/',
      source: 'render',
      $exception_list: [
        {
          type: 'RangeError',
          value: 'Invalid currency code : US',
          stacktrace: { type: 'resolved', frames: resolvedFrames },
        },
      ],
    });
    expect(reportFrom(body, title)).toBe(
      [
        'GET / (route /, render)',
        '',
        'RangeError: Invalid currency code : US',
        `    at module evaluation (${chunk}:336)`,
        '    at doRender (.next/server/chunks/ssr/a._.js:3049)',
        '    (these frames are compiled .next/server chunks; find the source from the error and the request)',
      ].join('\n'),
    );
  });

  it('reads raw SDK frames, and leaves the compiled note off source frames', () => {
    const body = webhook({
      method: 'POST',
      path: '/api/cart',
      $exception_list: [
        {
          type: 'TypeError',
          value: 'Cannot read properties of undefined',
          stacktrace: {
            type: 'raw',
            frames: [
              { in_app: true, filename: '/app/apps/demo-app/src/cart/route.ts', lineno: 9 },
              {
                in_app: true,
                filename: 'webpack://apps/demo-app/src/shop/money.ts',
                function: 'formatCents',
                lineno: 3,
                colno: 13,
                vars: { email: 'someone@example.com' },
                context_line: 'const secret = process.env.TOKEN',
              },
            ],
          },
        },
      ],
    });
    expect(reportFrom(body, title)).toBe(
      [
        'POST /api/cart',
        '',
        'TypeError: Cannot read properties of undefined',
        '    at formatCents (apps/demo-app/src/shop/money.ts:3:13)',
        '    at apps/demo-app/src/cart/route.ts:9',
      ].join('\n'),
    );
  });

  it('drops query values, user and request fields, and masks emails', () => {
    const body = webhook({
      method: 'GET',
      path: '/search?q=jane@example.com&page=2',
      headers: { cookie: 'session=abc' },
      body: '{"card":"4242"}',
      $set: { email: 'jane@example.com' },
      $exception_list: [
        { type: 'Error', value: 'no account for jane@example.com', stacktrace: null },
      ],
    });
    const report = reportFrom(body, title);
    expect(report).toBe('GET /search?q=&page=\n\nError: no account for [email]');
    expect(report).not.toMatch(/session|4242|jane/);
  });

  it('takes a browser error path from $current_url, and lists causes', () => {
    const body = webhook({
      $current_url: 'https://shop.example.com/cart?coupon=SAVE10#top',
      $exception_list: [
        { type: 'Error', value: 'checkout failed' },
        { type: 'SyntaxError', value: 'Unexpected token' },
        'not an exception',
      ],
    });
    expect(reportFrom(body, title)).toBe(
      'Request to /cart?coupon=\n\nError: checkout failed\nCaused by: SyntaxError: Unexpected token',
    );
  });

  it('falls back to the title with no exception list or request', () => {
    expect(reportFrom(posthogWebhookFixture, 'TypeError: x of a@b.co')).toBe(
      'TypeError: x of [email]',
    );
    const unparsable = webhook({ $current_url: 'not a url', $exception_list: 'nope' });
    expect(reportFrom(unparsable, title)).toBe(title);
  });

  it('names an exception with no type or value, and caps the report', () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({
      in_app: true,
      source: `apps/demo-app/src/${'x'.repeat(600)}${i}.ts`,
      line: i,
    }));
    const body = webhook({ $exception_list: [{ stacktrace: { frames } }] });
    const report = reportFrom(body, title);
    expect(report.startsWith('Exception\n')).toBe(true);
    expect(report.length).toBe(REPORT_MAX);
    expect(report.endsWith('...')).toBe(true);
  });

  it('skips frames without a file and repeats of the same frame', () => {
    const frame = { in_app: true, source: 'apps/demo-app/src/a.ts', line: 1, resolved_name: '?' };
    const body = webhook({
      $exception_list: [
        { type: 'Error', value: 'x', stacktrace: { frames: [{ in_app: true }, 7, frame, frame] } },
      ],
    });
    expect(reportFrom(body, title)).toBe('Error: x\n    at apps/demo-app/src/a.ts:1');
  });
});

describe('report helpers', () => {
  it('redacts query values and keeps the names', () => {
    expect(redactQuery('/a?x=1&y=&z')).toBe('/a?x=&y=&z=');
    expect(redactQuery('/a?')).toBe('/a');
    expect(redactQuery('/u/me@x.io#h')).toBe('/u/[email]');
  });

  it('masks emails', () => {
    expect(maskEmails('to a.b+c@mail.example.org, ok')).toBe('to [email], ok');
  });

  it('makes frame paths repo relative', () => {
    expect(framePath('turbopack:///[project]/apps/demo-app/src/x.ts')).toBe(
      'apps/demo-app/src/x.ts',
    );
    expect(framePath('file:///app/apps/demo-app/.next/server/a.js')).toBe(
      'apps/demo-app/.next/server/a.js',
    );
    expect(framePath('./src/x.ts')).toBe('src/x.ts');
  });
});
