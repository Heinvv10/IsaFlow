import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
import { sql } from '@/lib/neon';
import { deleteBankFeedConnection, listBankFeedConnections } from '@/modules/accounting/services/bank/openBankingConnectionService';
import { isSupportedProvider } from '@/modules/accounting/services/bank/openBankingTypes';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const text = (i: number) => (mockSql.mock.calls[i]![0] as unknown as string[]).join('?');
beforeEach(() => mockSql.mockReset());

describe('bank feed connection truthfulness', () => {
  it('supports only manual_csv and extension', () => {
    expect(['manual_csv', 'extension'].every(isSupportedProvider)).toBe(true);
    expect(['basiq', 'tink', 'plaid', 'stitch'].some(isSupportedProvider)).toBe(false);
  });

  it('disconnect is a soft state change that preserves history', async () => {
    mockSql.mockResolvedValue([]);
    await deleteBankFeedConnection('co', 'conn');
    expect(text(0)).toMatch(/status = 'disconnected'/);
    expect(text(0)).toMatch(/is_active = false/);
    expect(text(0)).not.toMatch(/DELETE/i);
  });

  it('lists masked account, last success and the latest sync counts', async () => {
    mockSql.mockResolvedValueOnce([{
      id: 'conn', company_id: 'co', provider: 'extension', account_id: 'gl', account_name: 'Cheque',
      account_number_masked: '****4567', external_account_id: null, status: 'active',
      last_sync_at: '2026-09-11T08:00:00Z', last_success_at: '2026-09-11T08:00:00Z',
      last_sync_status: 'success', last_sync_error: null, config: { bankId: 'absa' },
      created_at: '2026-09-01', updated_at: '2026-09-11',
      ls_found: 3, ls_imported: 2, ls_duplicate: 1, ls_updated: 0, ls_pending: 0, ls_removed: 0, ls_conflict: 0,
      ls_completed_at: '2026-09-11T08:00:01Z',
    }]);
    const [c] = await listBankFeedConnections('co');
    expect(c).toMatchObject({ accountNumberMasked: '****4567', lastSuccessAt: '2026-09-11T08:00:00Z',
      lastSync: { found: 3, imported: 2, duplicate: 1, pending: 0, conflicts: 0 } });
    expect(text(0)).toMatch(/company_id/);
  });
});
