import { describe, expect, it } from 'vitest';
import { errorName, errorProperties, FakeErrorReporter } from './reporter.ts';

describe('errorName', () => {
  it('uses the error class name', () => {
    expect(errorName(new TypeError('x'))).toBe('TypeError');
    expect(errorName(Object.assign(new Error('x'), { name: '' }))).toBe('Error');
  });

  it('reads a name off a plain object and labels everything else', () => {
    expect(errorName({ name: 'ZodError' })).toBe('ZodError');
    expect(errorName({ name: '' })).toBe('NonError');
    expect(errorName('boom')).toBe('StringError');
    expect(errorName(null)).toBe('NonError');
  });
});

describe('errorProperties', () => {
  it('adds the name and release and drops empty context fields', () => {
    expect(
      errorProperties(
        new RangeError('bad'),
        { route: '/orders/[id]', path: '', digest: undefined },
        'abc123',
      ),
    ).toEqual({ error_name: 'RangeError', release: 'abc123', route: '/orders/[id]' });
  });

  it('leaves the release out when none is given', () => {
    expect(errorProperties(new Error('x'), {})).toEqual({ error_name: 'Error' });
  });
});

describe('FakeErrorReporter', () => {
  it('records each exception with its properties', async () => {
    const fake = new FakeErrorReporter('sha');
    const error = new Error('boom');
    await fake.captureException(error, { route: '/', method: 'GET' });
    expect(fake.captured).toEqual([
      { error, properties: { error_name: 'Error', release: 'sha', route: '/', method: 'GET' } },
    ]);
  });
});
