/**
 * Tiny promise pool — runs at most `concurrency` async tasks at once.
 *
 * Used by the bulk bank-statement uploader to fire N preview requests
 * without overwhelming the server (or the user's connection). Returns
 * results in input order with each slot's success/failure preserved.
 */

export type PoolResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

export async function runWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
  onSettled?: (index: number, result: PoolResult<TResult>) => void,
): Promise<PoolResult<TResult>[]> {
  if (concurrency < 1) throw new Error('concurrency must be >= 1');

  const results = new Array<PoolResult<TResult>>(items.length);
  let cursor = 0;

  const next = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        const value = await worker(items[i]!, i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
      onSettled?.(i, results[i]!);
    }
  };

  const runners: Promise<void>[] = [];
  for (let r = 0; r < Math.min(concurrency, items.length); r++) runners.push(next());
  await Promise.all(runners);
  return results;
}
