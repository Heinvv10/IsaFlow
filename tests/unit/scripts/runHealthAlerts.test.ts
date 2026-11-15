/**
 * OP-1: scripts/ops/run-health-alerts.ts (the 5-minute timer's job) runs the
 * route's checkAndAlert exactly once per pass and exits non-zero when it fails,
 * so systemd records the failed run. The database pool and alert delivery are
 * mocked: no email or webhook leaves this test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ alertError: null as Error | null }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

vi.mock('@/lib/logger', () => ({ log }));
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({
  getPlatformAdminPool: () => ({
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
  }),
}));
vi.mock('@/modules/admin/services/systemHealthService', () => ({
  buildSystemHealth: vi.fn(async () => ({ overall_status: 'critical', checked_at: '2026-11-15T10:00:00.000Z' })),
}));
vi.mock('@/modules/admin/services/healthAlertService', () => ({
  checkAndAlert: vi.fn(async () => { if (fx.alertError) throw fx.alertError; }),
}));

import { main } from '../../../scripts/ops/run-health-alerts';
import { checkAndAlert } from '@/modules/admin/services/healthAlertService';

beforeEach(() => {
  fx.alertError = null;
  vi.mocked(checkAndAlert).mockClear();
  log.info.mockClear();
  log.error.mockClear();
});

describe('run-health-alerts script', () => {
  it('calls checkAndAlert once with the snapshot and exits 0', async () => {
    await expect(main()).resolves.toBe(0);
    expect(checkAndAlert).toHaveBeenCalledTimes(1);
    expect(checkAndAlert).toHaveBeenCalledWith(expect.objectContaining({ overall_status: 'critical' }));
    expect(log.info).toHaveBeenCalledWith('Scheduled health alert check done', { overall_status: 'critical' }, 'health-alert-timer');
  });

  it('exits non-zero and logs the cause when checkAndAlert throws', async () => {
    fx.alertError = new Error('SMTP settings unreadable');
    await expect(main()).resolves.toBe(1);
    expect(checkAndAlert).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith('Scheduled health alert check failed',
      { error: 'SMTP settings unreadable' }, 'health-alert-timer');
  });
});
