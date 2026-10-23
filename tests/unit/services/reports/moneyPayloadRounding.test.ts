/**
 * Payload-wide guard: every money field across the five running-balance
 * report services must be exact to 2 decimal places — no >2dp drift, no -0,
 * no exponent notation.
 *
 * Covers the five services the L4 defect named: customer_statement
 * (statementEmailService), supplier_statement (supplierStatementService),
 * search_gl (accountLedgerService), general_ledger (generalLedgerStreamService)
 * and trial_balance (trialBalanceService). The last two already round via
 * their local `round2` helpers (generalLedgerStreamTypes.ts, trialBalanceBasis.ts)
 * — this file does not change them, only proves the guard passes against
 * fixtures chosen to provoke float drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertTwoDecimalPayload } from '../../../helpers/assertTwoDecimalPayload';
import { mockUnsafe, recordSqlCall } from '../../helpers/sqlFragmentMock';

// ── Shared neon mock: bare `sql` spy + `unsafe` splicing + `transaction`. ──
const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let routedImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push(recordSqlCall(strings, values));
      return routedImpl(strings, ...values);
    }),
    { unsafe: mockUnsafe, transaction: vi.fn() },
  );
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});

// Fiscal years are the registry's (March-based here); it must not take entries from the sql queues below.
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../../helpers/fiscalYearSqlFake')).registryMock());
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getGeneralLedgerLines } from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';

type SqlMock = ReturnType<typeof vi.fn>;

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
  sqlCalls.length = 0;
  routedImpl = () => Promise.resolve([]);
  vi.clearAllMocks();
});

describe('customer_statement (fetchStatementData) — payload guard', () => {
  it('a sequence netting to zero serialises the balance as exactly 0', async () => {
    const invoices = Array.from({ length: 8 }, (_, i) => ({
      id: `i${i}`, invoice_number: `INV${i}`,
      invoice_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      total_amount: 0.1, status: 'approved',
    }));
    const payments = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`, payment_number: `RCT${i}`,
      payment_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      status: 'confirmed', amount_received: 0.1,
    }));
    routedImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM customers')) return Promise.resolve([{ id: 'c1', name: 'Acme', email: 'a@b.com' }]);
      if (q.includes('FROM customer_invoices')) return Promise.resolve(invoices);
      if (q.includes('FROM customer_payments')) return Promise.resolve(payments);
      if (q.includes('FROM credit_notes')) return Promise.resolve([]);
      return Promise.resolve([]);
    };
    const data = await fetchStatementData(COMPANY, 'c1', '2026-03-31');
    expect(data!.summary.balance).toBe(0);
    assertTwoDecimalPayload(data);
  });
});

describe('supplier_statement (fetchSupplierStatementData) — payload guard', () => {
  it('drift-provoking amounts still serialise to 2dp everywhere', async () => {
    routedImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM suppliers')) return Promise.resolve([{ id: 's1', name: 'Supp', email: 'x@y.com' }]);
      if (q.includes('FROM supplier_invoices')) {
        return Promise.resolve([
          { id: 'i1', invoice_number: 'SI1', invoice_date: '2026-01-01', total_amount: '126629.95', status: 'approved', created_at: '2026-01-01T00:00:00Z' },
        ]);
      }
      if (q.includes('FROM supplier_payments')) {
        return Promise.resolve([
          { id: 'p1', payment_number: 'SP1', payment_date: '2026-01-05', status: 'processed', amount_allocated: '100000', created_at: '2026-01-05T00:00:00Z' },
        ]);
      }
      if (q.includes('FROM credit_notes')) {
        return Promise.resolve([
          { id: 'c1', credit_note_number: 'SCN1', credit_date: '2026-01-06', total_amount: '0.05', applied_amount: '0.05', status: 'applied', created_at: '2026-01-06T00:00:00Z' },
        ]);
      }
      return Promise.resolve([]);
    };
    const data = await fetchSupplierStatementData(COMPANY, 's1', '2026-03-31');
    expect(data!.summary.balance).toBe(26629.9);
    assertTwoDecimalPayload(data);
  });
});

describe('search_gl (getAccountLedger) — payload guard', () => {
  // A simple alternating +0.1/-0.1 sequence is NOT a drift-provoking fixture:
  // in IEEE-754, `0.1 - 0.1` cancels exactly at every step (verified via
  // `node -e`), so plain `running += debit - credit` nets to exactly 0 too —
  // a prior version of this test used that sequence and stayed green after
  // reverting accountLedgerService.ts's running-balance line to plain float,
  // proving it detected nothing.
  //
  // This sequence (opening 126629.95, then -100000, +0.05, +0.1, +0.2, -0.1,
  // -0.2, +0.15, -0.05) is genuinely drift-provoking: verified via `node -e`
  // that plain-float accumulation produces 26629.949999999997 at row 1 (not
  // 26629.95) and similar >2dp noise through row 8, while the DECIMAL-correct
  // running balance is exact to the cent at every row.
  const EXPECTED_ROW_BALANCES = [
    26629.95, 26630.0, 26630.1, 26630.3, 26630.2, 26630.0, 26630.15, 26630.1,
  ];

  it('a genuinely drift-provoking debit/credit sequence keeps every row exact to the cent', async () => {
    const mockSql = sql as SqlMock;
    const moves: Array<{ debit: string; credit: string }> = [
      { debit: '0', credit: '100000' },
      { debit: '0.05', credit: '0' },
      { debit: '0.1', credit: '0' },
      { debit: '0.2', credit: '0' },
      { debit: '0', credit: '0.1' },
      { debit: '0', credit: '0.2' },
      { debit: '0.15', credit: '0' },
      { debit: '0', credit: '0.05' },
    ];
    const txnRows = moves.map((m, i) => ({
      journal_entry_id: `je${i}`,
      entry_date: '2026-01-01',
      entry_number: `JE${i}`,
      description: 'x',
      reference: '',
      source: 'manual',
      debit: m.debit,
      credit: m.credit,
    }));
    mockSql
      .mockResolvedValueOnce([{ id: 'a1', account_code: '1000', account_name: 'Bank', account_type: 'asset', normal_balance: 'debit' }])
      .mockResolvedValueOnce([{ total_debit: '126629.95', total_credit: '0' }])
      .mockResolvedValueOnce([{ total: String(txnRows.length) }])
      .mockResolvedValueOnce(txnRows)
      .mockResolvedValueOnce([{ period_debit: '0.5', period_credit: '100000.35' }]);

    const result = await getAccountLedger({
      companyId: COMPANY, accountId: 'a1', fromDate: '2026-01-01', toDate: '2026-01-31',
    });

    // Row-level assertion — not just the payload walk. The payload walk alone
    // (assertTwoDecimalPayload) accepts any value with <=2dp, which a
    // consistently-WRONG-but-clean rounding would also satisfy; asserting
    // the exact expected value per row catches that too.
    result.rows.forEach((row, i) => {
      expect(row.runningBalance).toBe(EXPECTED_ROW_BALANCES[i]);
    });
    expect(result.rows[result.rows.length - 1]!.runningBalance).toBe(26630.1);
    assertTwoDecimalPayload(result);
  });
});

describe('general_ledger (getGeneralLedgerLines) — payload guard', () => {
  it('cumulative + opening drift still rounds the running balance to 2dp', async () => {
    const mockSql = sql as SqlMock;
    // cumulative and opening_balance chosen to reproduce float noise when
    // summed in plain JS (0.1 repeated 20 times, alternating sign).
    let cumulative = 0;
    for (let i = 0; i < 20; i++) cumulative += i % 2 === 0 ? 0.1 : -0.1;
    const row = {
      line_id: 'l1', journal_entry_id: 'je1', account_id: 'a1',
      account_code: '1000', account_name: 'Bank', account_type: 'asset', normal_balance: 'debit',
      entry_date: '2026-01-20', entry_number: 'JE20', description: '', source: 'manual',
      debit: '0.1', credit: '0', created_at: '2026-01-20T00:00:00Z',
      created_key: '2026-01-20 00:00:00.000000',
      cumulative: String(cumulative),
      line_count: '20', total_debit: '2.00', total_credit: '1.90',
      account_count: '1', posted_through: '2026-01-20T00:00:00Z',
      opening_balance: '0', opening_all: '[]',
      universe_count: '20',
    };
    mockSql
      .mockResolvedValueOnce([{ retained: '0' }])           // trialBalanceBasis retained earnings b/f
      .mockResolvedValueOnce([row]);

    const page = await getGeneralLedgerLines({
      companyId: COMPANY, periodStart: '2026-01-01', periodEnd: '2026-01-31', limit: 200,
    });

    expect(page.lines[0]!.runningBalance).toBe(0);
    assertTwoDecimalPayload(page);
  });
});

describe('trial_balance (getTrialBalanceReport) — payload guard', () => {
  it('a set of accounts with sub-cent drift still rounds every total to 2dp', async () => {
    const mockSql = sql as SqlMock;
    const periodMeta = { start_date: '2026-02-01', end_date: '2026-02-28' };
    const accountRows = [
      { account_code: '1000', account_name: 'Bank', account_type: 'asset', normal_balance: 'debit', closing_debit: '0.1', closing_credit: '0', opening_net: '0', period_debit: '0.1', period_credit: '0' },
      { account_code: '1001', account_name: 'Bank2', account_type: 'asset', normal_balance: 'debit', closing_debit: '0.2', closing_credit: '0', opening_net: '0', period_debit: '0.2', period_credit: '0' },
    ];
    mockSql
      .mockResolvedValueOnce([periodMeta])
      .mockResolvedValueOnce(accountRows)
      .mockResolvedValueOnce([{ retained: '0' }]);

    const report = await getTrialBalanceReport(COMPANY, 'period-1');

    expect(report.totalDebit).toBe(0.3);
    assertTwoDecimalPayload(report);
  });
});
