import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { transaction: vi.fn() }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { mapLineRow } from '@/modules/accounting/services/gl/journalEntryCrudService';

describe('journal line business-unit readback', () => {
  it.each(['66666666-6666-6666-6666-666666666666', null, undefined])(
    'preserves the stored attribution (%s)', (buId) => {
      const line = mapLineRow({
        id: 'line', journal_entry_id: 'entry', gl_account_id: 'account',
        debit: '1000', credit: '0', bu_id: buId, created_at: '2026-09-09',
      });
      expect(line).toHaveProperty('buId', buId ?? undefined);
    },
  );
});
