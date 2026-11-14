import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: mocks.sql }));

import { getPlatformSettings } from '@/modules/admin/services/analyticsService';

describe('platform settings', () => {
  beforeEach(() => {
    mocks.sql.mockReset();
  });

  it('returns only the derived SMTP flag and never reads stored rows (removed toggles stay unread)', async () => {
    mocks.sql.mockResolvedValue([
      { key: 'maintenance_mode', value: true },
      { key: 'default_trial_days', value: 14 },
    ]);

    await expect(getPlatformSettings()).resolves.toEqual({ smtp_configured: false });
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
