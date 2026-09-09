/**
 * The bank-feed sync route maps an unimplemented provider to 400, not 500.
 *
 * `withAuth` ROLLBACKs the request transaction on any status >= 500, so an
 * uncaught throw would discard the failed sync log and the connection's
 * last_sync_error that syncBankFeed writes before refusing (K-018). A 4xx
 * COMMITs them, and the Bank Feeds page renders `error.message` from that
 * envelope, so the user is told why.
 *
 * Only the SQL layer is mocked — the real route calls the real service, so a
 * regression in either the refusal or the status mapping fails this test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, message: string) => ({ kind: 'badRequest', message })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import handler from '../../../pages/api/accounting/bank-feeds/[id]/sync';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const CONNECTION_ID = '00000000-0000-0000-0000-000000000002';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const LOG_ID = '00000000-0000-0000-0000-000000000004';

function req() {
  return {
    method: 'POST',
    query: { id: CONNECTION_ID },
    companyId: COMPANY_ID,
    user: { id: USER_ID },
  } as never;
}

/** connection lookup, then the sync-log INSERT; markSyncFailed's UPDATEs follow. */
function connectionOf(provider: string) {
  mockSql.mockResolvedValueOnce([{
    id: CONNECTION_ID, company_id: COMPANY_ID, provider,
    bank_account_id: '00000000-0000-0000-0000-000000000005',
    account_name: 'Cheque', is_active: true,
  }]);
  mockSql.mockResolvedValueOnce([{ id: LOG_ID }]);
  mockSql.mockResolvedValue([]);
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/accounting/bank-feeds/[id]/sync — refusal mapping', () => {
  it.each(['basiq', 'tink', 'plaid'])(
    'answers badRequest with the reason for %s',
    async (provider) => {
      connectionOf(provider);

      const out = await handler(req(), {} as NextApiResponse) as
        { kind: string; message: string };

      expect(out.kind).toBe('badRequest');
      expect(out.message).toMatch(new RegExp(provider));
      expect(out.message).toMatch(/not implemented/);
      // markSyncFailed ran before the refusal: 2 lookups + 2 UPDATEs.
      expect(mockSql).toHaveBeenCalledTimes(4);
    },
  );

  it('lets an unrelated failure through so the error handler answers 500', async () => {
    mockSql.mockResolvedValueOnce([]); // connection lookup finds nothing
    await expect(handler(req(), {} as NextApiResponse))
      .rejects.toThrow('Connection not found or does not belong to this company');
  });

  it('still returns the sync result for an implemented provider', async () => {
    connectionOf('manual_csv');

    const out = await handler(req(), {} as NextApiResponse) as
      { kind: string; data: { imported: number; instructions: string } };

    expect(out.kind).toBe('success');
    expect(out.data.imported).toBe(0);
    expect(out.data.instructions).toMatch(/CSV/);
  });
});
