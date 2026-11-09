/**
 * Runs `run` on every item, at most `limit` at a time, starting them in list order. `done`
 * gets each result in list order too, as soon as that item and every one before it have
 * finished, so output stays in a fixed order however the runs interleave. With a limit of
 * 1 this is a plain serial loop.
 *
 * `run` and `done` should not throw: an error rejects the whole call once the runs in
 * flight end, and no new run starts after it.
 */
export async function runInOrder<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
  done: (result: R, item: T) => void,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }
  const results: { value: R }[] = [];
  let next = 0;
  let reported = 0;
  let rejected = false;

  const worker = async () => {
    while (next < items.length && !rejected) {
      const i = next++;
      try {
        results[i] = { value: await run(items[i]!) };
        while (results[reported]) {
          done(results[reported]!.value, items[reported]!);
          reported++;
        }
      } catch (err) {
        rejected = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((s) => s.status === 'rejected');
  if (failure) throw failure.reason;
}

/**
 * Serializes the calls made through it: each runs once the one before it has settled,
 * whatever the outcome.
 */
export function serialized(): <R>(fn: () => Promise<R>) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}
