import { describe, it, expect, vi } from 'vitest';
import { runWithConcurrency } from '@/lib/bulkUpload/concurrencyQueue';

describe('runWithConcurrency', () => {
  it('runs all items and returns results in input order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrency(items, 2, async (n) => n * 10);
    expect(results.map(r => r.status === 'fulfilled' ? r.value : null)).toEqual([10, 20, 30, 40, 50]);
  });

  it('caps active workers at the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const worker = async () => {
      active++;
      if (active > maxActive) maxActive = active;
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
    };
    await runWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 3, worker);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('captures rejections per slot without aborting other slots', async () => {
    const results = await runWithConcurrency(
      ['ok', 'fail', 'ok'],
      2,
      async (item) => {
        if (item === 'fail') throw new Error('boom');
        return item;
      },
    );
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' });
    expect(results[1]?.status).toBe('rejected');
    expect((results[1] as { reason: Error }).reason.message).toBe('boom');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'ok' });
  });

  it('invokes onSettled with index and result for every item', async () => {
    const onSettled = vi.fn();
    await runWithConcurrency([1, 2], 1, async (n) => n + 1, onSettled);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledWith(0, { status: 'fulfilled', value: 2 });
    expect(onSettled).toHaveBeenCalledWith(1, { status: 'fulfilled', value: 3 });
  });

  it('throws on invalid concurrency', async () => {
    await expect(runWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(/concurrency/);
  });

  it('handles empty input', async () => {
    const results = await runWithConcurrency([], 3, async (n) => n);
    expect(results).toEqual([]);
  });
});
