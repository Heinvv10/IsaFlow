import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sql } from '@/lib/neon';
import { upsertBrandProfile } from '@/modules/accounting/services/afs/brandProfileService';

describe('upsertBrandProfile contrast gate', () => {
  it('refuses a primary colour that cannot carry white text, without touching the database', async () => {
    await expect(upsertBrandProfile('c1', {
      primaryColour: '#f5f5f5', secondaryColour: '#c8a86b',
      fontFamily: 'professional', coverStyle: 'classic', logoUrl: null, reportFooterText: null,
    })).rejects.toThrow(/primaryColour/);
    expect(sql).not.toHaveBeenCalled();
  });
});
