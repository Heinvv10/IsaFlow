/**
 * PRD-11 §5 — resolve a bank transaction by the reference printed on the
 * statement, so an agent transcribing a PDF never has to fetch ids first.
 */
process.env.TZ = 'Africa/Johannesburg';

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  return { sql: vi.fn(), fmtDate: actual.fmtDate };
});

import { sql } from '@/lib/neon';
import { findBankTransactionsByReference } from '@/modules/accounting/services/bank/bankTransactionLookupService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const BANK_ACCOUNT_ID = 'ba-0000-0000-0000-000000000001';

const ROW = {
  id: 'btx-1',
  transaction_date: new Date('2026-02-28T22:30:00Z'), // 00:30 SAST on 1 March
  amount: '-1234.56',
  description: 'FNB OB PMT ACME',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
});

describe('findBankTransactionsByReference', () => {
  it('scopes the query to the caller company and matches the reference exactly', async () => {
    mockSql.mockResolvedValueOnce([ROW]);

    await findBankTransactionsByReference(COMPANY_ID, 'REF-001');

    const call = mockSql.mock.calls[0]!;
    const text = (call[0] as unknown as string[]).join('?');
    expect(text).toContain('company_id');
    expect(call).toContain(COMPANY_ID);
    expect(call).toContain('REF-001');
    // Exact match, never LIKE — a prefix match would allocate the wrong row.
    expect(text).not.toMatch(/LIKE|ILIKE/i);
  });

  it('trims the supplied reference before matching', async () => {
    await findBankTransactionsByReference(COMPANY_ID, '  REF-001\n');
    expect(mockSql.mock.calls[0]!).toContain('REF-001');
  });

  it('returns no rows — and issues no query — for a blank reference', async () => {
    const res = await findBankTransactionsByReference(COMPANY_ID, '   ');
    expect(res).toEqual([]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('narrows by bank_account_id when one is supplied', async () => {
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001', BANK_ACCOUNT_ID);
    const call = mockSql.mock.calls[0]!;
    expect((call[0] as unknown as string[]).join('?')).toContain('bank_account_id');
    expect(call).toContain(BANK_ACCOUNT_ID);
  });

  it('omits the bank_account_id predicate when none is supplied', async () => {
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    expect((mockSql.mock.calls[0]![0] as unknown as string[]).join('?'))
      .not.toContain('bank_account_id');
  });

  it('renders the candidate date in local terms, not UTC', async () => {
    mockSql.mockResolvedValueOnce([ROW]);
    const res = await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    expect(res).toEqual([{
      id: 'btx-1',
      transactionDate: '2026-03-01',
      amount: -1234.56,
      description: 'FNB OB PMT ACME',
    }]);
  });

  it('returns every candidate when the reference repeats', async () => {
    mockSql.mockResolvedValueOnce([ROW, { ...ROW, id: 'btx-2' }]);
    const res = await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    expect(res.map((r) => r.id)).toEqual(['btx-1', 'btx-2']);
  });
});
