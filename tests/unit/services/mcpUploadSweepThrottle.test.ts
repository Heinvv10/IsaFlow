/**
 * The PUT route's sweep is throttled per process: a flood of PUTs is not a flood of sweep statements. The tools keep
 * sweeping on every call (sweepExpiredUploadsQuietly).
 */
import { describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn(async () => ({ rowCount: 0 })));
vi.mock('@/lib/mcp/uploadAdminPool', () => ({ uploadAdminPool: () => ({ query }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { SWEEP_MIN_INTERVAL_MS, sweepExpiredUploadsThrottled } from '@/modules/accounting/services/core/mcpUploadIntentSweep';

describe('sweepExpiredUploadsThrottled', () => {
  it('runs at most once per interval per process', async () => {
    const t0 = 1_000_000;
    expect(await sweepExpiredUploadsThrottled(t0)).toBe(true);
    expect(await sweepExpiredUploadsThrottled(t0 + 1)).toBe(false);
    expect(await sweepExpiredUploadsThrottled(t0 + SWEEP_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(await sweepExpiredUploadsThrottled(t0 + SWEEP_MIN_INTERVAL_MS)).toBe(true);
    expect(query).toHaveBeenCalledTimes(4); // two statements per sweep, two sweeps
  });
});

describe('sweepExpiredUploadsQuietly', () => {
  it('waits at most its bound for a sweep that cannot get a connection, and never throws', async () => {
    const { sweepExpiredUploadsQuietly } = await import('@/modules/accounting/services/core/mcpUploadIntentSweep');
    query.mockImplementationOnce(() => new Promise(() => undefined)); // a pool checkout that never comes
    const started = Date.now();
    await sweepExpiredUploadsQuietly(50);
    expect(Date.now() - started).toBeLessThan(1_000);
    query.mockRejectedValueOnce(new Error('pool down'));
    await expect(sweepExpiredUploadsQuietly(50)).resolves.toBeUndefined();
  });
});
