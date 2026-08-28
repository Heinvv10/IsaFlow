/**
 * PRD-11 §5 — resolve a bank transaction by the reference printed on the
 * statement, so an agent transcribing a PDF never has to fetch ids first.
 *
 * The reference lives in `bank_transactions.reference`, NOT in
 * `bank_reference`. Production, 2026-08-28: 9,824 rows carry `reference` and
 * ZERO carry `bank_reference` — every statement importer writes the former,
 * and the two feed syncs that write the latter store the provider's external
 * id there. Matching one column meant the MCP pilot's
 * `bank_reference:"20220402-0011"` came back NOT_FOUND for a row that
 * allocated fine by transaction_id, so these tests pin the SQL text: that is
 * where the defect lived, and a mocked row mapper sailed through the whole
 * outage.
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
  matched_reference: 'REF-001',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
});

/** The template text of the nth sql call, with `?` where a binding sat. */
function sqlText(n: number): string {
  return (mockSql.mock.calls[n]![0] as unknown as string[]).join('?').replace(/\s+/g, ' ');
}

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
      matchedReference: 'REF-001',
    }]);
  });


  it('matches EITHER reference or bank_reference — account-wide branch', async () => {
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    const text = sqlText(0);
    // The OR-pair, not merely both column names: the SELECT list mentions both
    // columns to report which one matched, so a name check alone would stay
    // green with a single-column WHERE — exactly the shipped defect.
    expect(text).toMatch(/\(\s*btrim\(reference\) = \? OR btrim\(bank_reference\) = \?\s*\)/);
  });

  it('matches EITHER column when narrowed to one bank account', async () => {
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001', BANK_ACCOUNT_ID);
    expect(sqlText(0)).toMatch(/\(\s*btrim\(reference\) = \? OR btrim\(bank_reference\) = \?\s*\)/);
  });

  it('keeps the candidate list bounded in both branches', async () => {
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001', BANK_ACCOUNT_ID);
    for (const call of mockSql.mock.calls) {
      expect((call[0] as unknown as string[]).join('?')).toContain('LIMIT');
      expect(call).toContain(25);
    }
  });

  it('reports the stored value that matched, so an ambiguity reply can show it', async () => {
    mockSql.mockResolvedValueOnce([
      { ...ROW, matched_reference: 'REF-001' },
      { ...ROW, id: 'btx-2', matched_reference: 'FEED-EXTERNAL-77' },
      { ...ROW, id: 'btx-3', matched_reference: null },
    ]);
    const res = await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    expect(res.map((r) => r.matchedReference)).toEqual(['REF-001', 'FEED-EXTERNAL-77', null]);
  });

  it('returns every candidate when the reference repeats', async () => {
    mockSql.mockResolvedValueOnce([ROW, { ...ROW, id: 'btx-2' }]);
    const res = await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    expect(res.map((r) => r.id)).toEqual(['btx-1', 'btx-2']);
  });
});
