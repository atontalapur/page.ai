import { describe, expect, it } from 'vitest';
import { classifyByRules } from './rules.ts';

const classOf = (title: string, report: string | null = null) =>
  classifyByRules({ title, report }).class;

/** A report as ingest builds it: the request line, a blank line, the error and its frames. */
const report = (request: string, error: string, ...frames: string[]) =>
  [request, '', error, ...frames.map((frame) => `    at ${frame}`)].join('\n');

describe('classifyByRules', () => {
  it('reads only the title when the issue has no report', () => {
    expect(classifyByRules({ title: 'Hydration failed', report: null })).toEqual({
      class: 'frontend',
      severity: 'medium',
    });
    expect(classOf('TypeError: x is undefined')).toBe('backend-api');
  });

  it('files a config or env frame, or an env var name, as infra-config', () => {
    const settings = report(
      'GET / (route /, render)',
      'TypeError: Cannot read properties of undefined',
      'loadSettings (apps/demo-app/src/settings/index.ts:4:2)',
      'HomePage (apps/demo-app/src/app/page.tsx:7:18)',
    );
    expect(classOf('TypeError: Cannot read properties of undefined', settings)).toBe(
      'infra-config',
    );
    // A bad setting breaks every request that reads it, so it pages high.
    expect(classifyByRules({ title: 'Error: SMTP_HOST is required', report: null })).toEqual({
      class: 'infra-config',
      severity: 'high',
    });
    // A Node error code looks like an env var name but isn't one.
    expect(classOf('TypeError: Invalid URL ERR_INVALID_URL')).toBe('backend-api');
  });

  it('files a Postgres error, a SQL frame or a migration frame as database', () => {
    expect(classOf('error: canceling statement due to statement timeout')).toBe('database');
    const migration = report(
      'POST /api/cart (route /api/cart, route)',
      'Error: boom',
      'up (apps/demo-app/src/db/migrations/004-cart.ts:3:1)',
    );
    expect(classOf('Error: boom', migration)).toBe('database');
  });

  it('files a component frame, a page request or a browser error as frontend', () => {
    const component = report(
      'POST /api/cart (route /api/cart, route)',
      'TypeError: x is undefined',
      'CartBadge (apps/demo-app/src/app/cart-badge.tsx:9:3)',
    );
    expect(classOf('TypeError: x is undefined', component)).toBe('frontend');
    expect(classOf('TypeError: x', report('GET /cart (route /cart, render)', 'TypeError: x'))).toBe(
      'frontend',
    );
    expect(classOf('TypeError: x', report('Request to /cart', 'TypeError: x'))).toBe('frontend');
    expect(classOf('TypeError: x', report('GET /cart', 'TypeError: x'))).toBe('frontend');
  });

  it('files an API route error with no other signal as backend-api', () => {
    const api = report(
      'POST /api/cart/items (route /api/cart/items, route)',
      'TypeError: x',
      'addItem (apps/demo-app/src/shop/cart.ts:90:27)',
    );
    expect(classifyByRules({ title: 'TypeError: x', report: api })).toEqual({
      class: 'backend-api',
      severity: 'high',
    });
    expect(classOf('TypeError: x', report('GET /api/cart', 'TypeError: x'))).toBe('backend-api');
  });

  describe('a value Postgres rejected', () => {
    const outOfRange = 'error: value "3000000000" is out of range for type integer';

    it('is a missing check in the page or route when the request sent it', () => {
      const page = report('GET /orders/3000000000 (route /orders/[id], render)', outOfRange);
      expect(classOf(outOfRange, page)).toBe('frontend');
      const api = report('GET /api/orders/3000000000 (route /api/orders/[id], route)', outOfRange);
      expect(classOf(outOfRange, api)).toBe('backend-api');
    });

    it('is a setting when a number the request did not send overflows', () => {
      expect(
        classOf(outOfRange, report('POST /api/orders (route /api/orders, route)', outOfRange)),
      ).toBe('infra-config');
      expect(classOf(outOfRange)).toBe('infra-config');
    });

    it('is the query when it is an array literal, and the code otherwise', () => {
      const array = 'error: invalid input syntax for type integer: "{"3"}"';
      expect(classOf(array, report('POST /api/orders', array))).toBe('database');
      const nan = 'error: invalid input syntax for type bigint: "NaN"';
      expect(classOf(nan, report('GET /api/products', nan))).toBe('backend-api');
    });
  });

  it('pages checkout, payment and fatal errors as critical', () => {
    const checkout = report('POST /checkout (route /checkout, action)', 'TypeError: x');
    expect(classifyByRules({ title: 'TypeError: x', report: checkout })).toEqual({
      class: 'frontend',
      severity: 'critical',
    });
  });

  it('skips the compiled frames note', () => {
    const compiled = [
      'GET /api/cart (route /api/cart, route)',
      '',
      'TypeError: x',
      '    at /app/.next/server/chunks/ssr/a._.js:1:2',
      '    (these frames are compiled .next/server chunks; find the source from the error and the request)',
    ].join('\n');
    expect(classOf('TypeError: x', compiled)).toBe('backend-api');
  });
});
