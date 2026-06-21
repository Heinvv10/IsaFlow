/**
 * Unit tests for sageMigrationService.autoMapAccounts
 *
 * Tenant-isolation regression guard: the candidate-account fetch
 *   SELECT ... FROM gl_accounts WHERE level >= 3 AND is_active = true
 * omitted company_id, so the name-similarity matcher could map a company's
 * Sage account to ANOTHER company's GL account. The resulting
 * sage_accounts.gl_account_id is later used to post journal entries, producing
 * cross-tenant GL line drift. The fix scopes the candidate fetch by company_id.
 *
 * All DB calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { autoMapAccounts } from '@/modules/accounting/services/core/sageMigrationService';

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const COMPANY_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID = 'user-1';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

function completeRunRow() {
  return {
    id: 'run-1', run_type: 'account_mapping', status: 'completed',
    total_records: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0,
    started_at: '2026-05-01T00:00:00Z', completed_at: '2026-05-01T00:00:01Z',
  };
}

describe('autoMapAccounts — GL candidate tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes the GL candidate-account fetch to companyId', async () => {
    sqlMock
      .mockResolvedValueOnce([{ id: 'run-1' }])                                       // startRun INSERT
      .mockResolvedValueOnce([                                                        // sage accounts
        { id: 'sage-1', sage_account_id: 's1', name: 'Bank Account', account_type: 5, balance: 0 },
      ])
      .mockResolvedValueOnce([                                                        // GL candidates
        { id: 'gl-A', account_code: '1110', account_name: 'Bank Account', account_type: 'asset' },
      ])
      .mockResolvedValueOnce([])                                                      // UPDATE sage_accounts
      .mockResolvedValueOnce([completeRunRow()]);                                     // completeRun

    await autoMapAccounts(COMPANY_A, USER_ID);

    const glFetch = sqlMock.mock.calls.find((args) =>
      /FROM\s+gl_accounts/i.test((args[0] as readonly string[]).join(' ')),
    );
    expect(glFetch, 'GL candidate fetch query not found').toBeDefined();

    const text = (glFetch![0] as readonly string[]).join(' ');
    expect(text).toMatch(/company_id/i);
    expect(glFetch!.slice(1)).toContain(COMPANY_A);
    expect(glFetch!.slice(1)).not.toContain(COMPANY_B);
  });
});
