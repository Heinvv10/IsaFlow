/**
 * Unit tests for openBankingSyncService — the extension provider returns
 * instructions without touching bank_transactions, and the IDOR guard rejects
 * a connection belonging to another company.
 *
 * The sample-transaction generator these guards were built around is gone
 * (K-018): the service no longer contains an INSERT into bank_transactions,
 * and an unimplemented provider now raises BankFeedProviderNotImplementedError.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sql } from '@/lib/neon';
import { syncBankFeed } from '@/modules/accounting/services/bank/openBankingSyncService';

type SqlFn = ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const CONNECTION_ID = '00000000-0000-0000-0000-000000000002';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const LOG_ID = '00000000-0000-0000-0000-000000000004';

beforeEach(() => vi.clearAllMocks());

describe('syncBankFeed — extension provider guard', () => {
  it.each(['extension', 'manual_csv'])(
    'returns instructions for %s and writes no sync log and no last_sync_* (A-12)', async (provider) => {
      // The only SQL is the company-scoped connection lookup.
      mockSql.mockResolvedValueOnce([{
        id: CONNECTION_ID, company_id: COMPANY_ID, provider,
        bank_account_id: null, account_name: null, is_active: true,
      }]);
      mockSql.mockResolvedValue([]);

      const result = await syncBankFeed(COMPANY_ID, CONNECTION_ID, USER_ID);

      expect(result.provider).toBe(provider);
      expect(result).toMatchObject({ found: 0, imported: 0, duplicate: 0, logId: null });
      expect(result.instructions).toMatch(/user-operated/);
      expect(mockSql).toHaveBeenCalledTimes(1);
    },
  );

  it('an unimplemented provider writes a failed log, both UPDATEs company-scoped (A-12)', async () => {
    mockSql.mockResolvedValueOnce([{ id: CONNECTION_ID, company_id: COMPANY_ID, provider: 'basiq', is_active: true }]);
    mockSql.mockResolvedValueOnce([{ id: LOG_ID }]);
    mockSql.mockResolvedValue([]);
    await expect(syncBankFeed(COMPANY_ID, CONNECTION_ID, USER_ID)).rejects.toThrow(/not implemented/);
    expect(mockSql).toHaveBeenCalledTimes(4);
    for (const i of [2, 3]) {
      const [strings, ...values] = mockSql.mock.calls[i]! as [TemplateStringsArray, ...unknown[]];
      const at = strings.findIndex((f, j) => j < strings.length - 1 && /company_id\s*=\s*$/.test(f));
      expect(at, strings.join('?')).toBeGreaterThanOrEqual(0);
      expect(values[at]).toBe(COMPANY_ID);
    }
  });

  it('rejects unknown connection (IDOR guard)', async () => {
    mockSql.mockResolvedValueOnce([]); // connection lookup returns empty
    await expect(syncBankFeed(COMPANY_ID, CONNECTION_ID, USER_ID))
      .rejects.toThrow('Connection not found or does not belong to this company');
  });
});
