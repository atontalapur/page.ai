import { describe, expect, it } from 'vitest';
import { runInOrder, serialized } from './pool.ts';

/** A promise with its resolve and reject, to finish runs in a chosen order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('runInOrder', () => {
  it('runs one at a time with a limit of 1', async () => {
    const log: string[] = [];
    await runInOrder(
      ['a', 'b', 'c'],
      1,
      async (x) => {
        log.push(`start ${x}`);
        await tick();
        log.push(`end ${x}`);
        return x.toUpperCase();
      },
      (r) => log.push(`done ${r}`),
    );
    expect(log).toEqual([
      'start a',
      'end a',
      'done A',
      'start b',
      'end b',
      'done B',
      'start c',
      'end c',
      'done C',
    ]);
  });

  it('calls reportedUpTo once done has caught up, not for an item it must wait behind', async () => {
    const gates = new Map(['a', 'b'].map((x) => [x, deferred<string>()]));
    const log: string[] = [];
    const running = runInOrder(
      ['a', 'b'],
      2,
      (x) => gates.get(x)!.promise,
      (r) => log.push(`done ${r}`),
      () => log.push('caught up'),
    );
    gates.get('b')!.resolve('B');
    await tick();
    expect(log).toEqual([]);
    gates.get('a')!.resolve('A');
    await running;
    expect(log).toEqual(['done A', 'done B', 'caught up']);
  });

  it('keeps at most `limit` in flight and reports in list order', async () => {
    const gates = new Map(['a', 'b', 'c', 'd'].map((x) => [x, deferred<string>()]));
    const started: string[] = [];
    const reported: string[] = [];
    const running = runInOrder(
      [...gates.keys()],
      2,
      (x) => {
        started.push(x);
        return gates.get(x)!.promise;
      },
      (r, x) => reported.push(`${x}=${r}`),
    );

    await tick();
    expect(started).toEqual(['a', 'b']);
    // b finishes first, but a is still running, so nothing is reported yet.
    gates.get('b')!.resolve('B');
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(reported).toEqual([]);
    gates.get('a')!.resolve('A');
    await tick();
    expect(reported).toEqual(['a=A', 'b=B']);
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    gates.get('d')!.resolve('D');
    gates.get('c')!.resolve('C');
    await running;
    expect(reported).toEqual(['a=A', 'b=B', 'c=C', 'd=D']);
  });

  it('handles no items and a limit above the item count', async () => {
    const reported: number[] = [];
    await runInOrder(
      [],
      3,
      () => Promise.resolve(0),
      (r) => reported.push(r),
    );
    await runInOrder(
      [1, 2],
      8,
      (x) => Promise.resolve(x * 10),
      (r) => reported.push(r),
    );
    expect(reported).toEqual([10, 20]);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a limit of %s', async (limit) => {
    await expect(
      runInOrder(
        [1],
        limit,
        () => Promise.resolve(1),
        () => {},
      ),
    ).rejects.toThrow(RangeError);
  });

  it('rejects after the runs in flight end, and starts no new one', async () => {
    const boom = new Error('boom');
    const slow = deferred<number>();
    const started: number[] = [];
    const running = runInOrder(
      [1, 2, 3, 4],
      2,
      (x) => {
        started.push(x);
        if (x === 1) return Promise.reject(boom);
        return slow.promise;
      },
      () => {},
    );
    let settled = false;
    running.catch(() => {}).finally(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    slow.resolve(2);
    await expect(running).rejects.toBe(boom);
    expect(started).toEqual([1, 2]);
  });
});

describe('serialized', () => {
  it('runs each call after the one before it settles, failed or not', async () => {
    const one = serialized();
    const log: string[] = [];
    const first = deferred<string>();
    const a = one(() => {
      log.push('start a');
      return first.promise;
    });
    const b = one(() => {
      log.push('start b');
      return Promise.resolve('B');
    });
    await tick();
    expect(log).toEqual(['start a']);
    first.reject(new Error('a failed'));
    await expect(a).rejects.toThrow('a failed');
    await expect(b).resolves.toBe('B');
    expect(log).toEqual(['start a', 'start b']);
  });
});
