import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: mocks.sql }));

import {
  getPlatformSettings,
  updatePlatformSettings,
} from '@/modules/admin/services/analyticsService';
import type { PlatformSettings } from '@/modules/admin/types/admin.types';

describe('platform settings trial length', () => {
  beforeEach(() => {
    mocks.sql.mockReset();
  });

  it('ignores the legacy persisted trial length because provisioning owns that policy', async () => {
    mocks.sql.mockResolvedValue([
      { key: 'maintenance_mode', value: true },
      { key: 'default_trial_days', value: 14 },
    ]);

    await expect(getPlatformSettings()).resolves.toEqual({
      maintenance_mode: true,
      registration_enabled: true,
      max_companies_per_user: 5,
      smtp_configured: false,
    });
  });

  it('does not persist the retired trial-length setting', async () => {
    await updatePlatformSettings(
      { default_trial_days: 90 } as unknown as Partial<PlatformSettings>,
      'admin-1',
    );

    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
