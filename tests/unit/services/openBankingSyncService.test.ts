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
  it('returns instructions and skips stub generator for extension provider', async () => {
    // First SQL call: connection lookup — returns an extension-provider connection.
    mockSql.mockResolvedValueOnce([{
      id: CONNECTION_ID,
      company_id: COMPANY_ID,
      provider: 'extension',
      bank_account_id: null,
      account_name: null,
      is_active: true,
    }]);
    // Second SQL call: INSERT into bank_feed_sync_logs — returns the log row.
    mockSql.mockResolvedValueOnce([{ id: LOG_ID }]);
    // Third SQL call: markSyncComplete UPDATE on bank_feed_sync_logs.
    mockSql.mockResolvedValueOnce([]);
    // Fourth SQL call: markSyncComplete UPDATE on bank_feed_connections.
    mockSql.mockResolvedValueOnce([]);

    const result = await syncBankFeed(COMPANY_ID, CONNECTION_ID, USER_ID);

    expect(result.provider).toBe('extension');
    expect(result.found).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.duplicate).toBe(0);
    expect(result.instructions).toMatch(/extension-ingest/);

    // Verify no transaction INSERT was attempted (would be a 5th SQL call).
    // The mock is set up with exactly 4 calls; any extra call would throw.
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('rejects unknown connection (IDOR guard)', async () => {
    mockSql.mockResolvedValueOnce([]); // connection lookup returns empty
    await expect(syncBankFeed(COMPANY_ID, CONNECTION_ID, USER_ID))
      .rejects.toThrow('Connection not found or does not belong to this company');
  });
});
