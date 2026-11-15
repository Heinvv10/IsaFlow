/**
 * OP-1: the scheduled health-alert pass takes the route's snapshot on the
 * platform_admin pool (read-only, under an ALS context on that client), then
 * calls the SAME checkAndAlert once, after the snapshot's transaction ended and
 * outside any ALS context (where the route's runAfterCommit starts it). A
 * failure is thrown so the timer's run fails, and alerts are never sent off a
 * snapshot that could not be taken. Alert delivery itself is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  queries: [] as string[],
  released: [] as unknown[],
  storeDuringSnapshot: undefined as unknown,
  storeDuringAlert: 'unset' as unknown,
  snapshotError: null as Error | null,
  alertError: null as Error | null,
  status: 'degraded' as 'healthy' | 'degraded' | 'critical',
}));

const client = vi.hoisted(() => ({
  query: vi.fn(async (text: string) => { fx.queries.push(text); return { rows: [] }; }),
  release: vi.fn((arg?: unknown) => { fx.released.push(arg); }),
}));

vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({
  getPlatformAdminPool: () => ({ connect: async () => client }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/admin/services/systemHealthService', async () => {
  const { als } = await import('@/lib/als');
  return {
    buildSystemHealth: vi.fn(async () => {
      fx.storeDuringSnapshot = als.getStore()?.client;
      if (fx.snapshotError) throw fx.snapshotError;
      return { overall_status: fx.status, checked_at: '2026-11-15T10:00:00.000Z' };
    }),
  };
});
vi.mock('@/modules/admin/services/healthAlertService', async () => {
  const { als } = await import('@/lib/als');
  return {
    checkAndAlert: vi.fn(async () => {
      fx.storeDuringAlert = als.getStore();
      if (fx.alertError) throw fx.alertError;
    }),
  };
});

import { runScheduledHealthAlert } from '@/modules/admin/services/healthAlertRun';
import { checkAndAlert } from '@/modules/admin/services/healthAlertService';

beforeEach(() => {
  fx.queries = [];
  fx.released = [];
  fx.storeDuringSnapshot = undefined;
  fx.storeDuringAlert = 'unset';
  fx.snapshotError = null;
  fx.alertError = null;
  fx.status = 'degraded';
  vi.mocked(checkAndAlert).mockClear();
});

describe('runScheduledHealthAlert', () => {
  it('snapshots on the platform_admin client in a read-only tx, then calls checkAndAlert once outside it', async () => {
    await expect(runScheduledHealthAlert()).resolves.toBe('degraded');

    expect(fx.storeDuringSnapshot).toBe(client);
    expect(fx.queries).toEqual(['BEGIN READ ONLY', 'COMMIT']);
    expect(fx.released).toEqual([false]);
    expect(checkAndAlert).toHaveBeenCalledTimes(1);
    expect(checkAndAlert).toHaveBeenCalledWith({ overall_status: 'degraded', checked_at: '2026-11-15T10:00:00.000Z' });
    expect(fx.storeDuringAlert).toBeUndefined();
  });

  it('passes a healthy snapshot through too, so checkAndAlert can reset the debounce state', async () => {
    fx.status = 'healthy';
    await expect(runScheduledHealthAlert()).resolves.toBe('healthy');
    expect(checkAndAlert).toHaveBeenCalledTimes(1);
  });

  it('throws when checkAndAlert throws', async () => {
    fx.alertError = new Error('admin_settings unreachable');
    await expect(runScheduledHealthAlert()).rejects.toThrow('admin_settings unreachable');
    expect(checkAndAlert).toHaveBeenCalledTimes(1);
  });

  it('rolls back, releases, never alerts and throws when the snapshot fails', async () => {
    fx.snapshotError = new Error('relation "background_jobs" does not exist');
    await expect(runScheduledHealthAlert()).rejects.toThrow('background_jobs');
    expect(fx.queries).toEqual(['BEGIN READ ONLY', 'ROLLBACK']);
    expect(fx.released).toEqual([false]);
    expect(checkAndAlert).not.toHaveBeenCalled();
  });
});
