import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-12-31';

// Opening cash now comes from cash.balance.v1's owning service
// (bank/cashBalanceService), which returns one row PER bank account with its
// `gl_debit`, `gl_credit` and `account_type`. fetchOpeningCash no longer
// carries its own copy of the query — that private copy is why cash had four
// answers.
const OPENING_ROWS = [
  { id: 'bank-1', account_code: '1110', account_name: 'Bank', is_active: true,
    account_type: 'asset', gl_debit: 15000, gl_credit: 0, posted_through: null },
];

// The service issues two queries: opening cash, then every posted journal with a cash leg in the period: one row per
// (journal, non-cash account kind) carrying the journal's net movement on its cash accounts. The cash amount repeats on
// a journal's rows and must be counted once. A previous version summed the cash leg per contra row inside SQL, which
// double-counted every multi-line entry; see tests/integration/afs-cash-flow-direct.int.test.ts for the ledger tie-out.
const mv = (journal: string, net: number, type: string, subtype: string | null, debit: number, credit: number) => ({
  journal_entry_id: journal, source: 'manual', net_cash: net, account_type: type, account_subtype: subtype,
  is_loan_current_portion: false, debit, credit,
});
const LEG_ROWS = [
  // One receipt of 80000 explained by two revenue lines.
  mv('L1', 80000, 'revenue', 'sales', 0, 50000),
  mv('L1', 80000, 'revenue', 'other_income', 0, 30000),
  // A supplier payment.
  mv('L2', -45000, 'expense', 'operating_expense', 45000, 0),
  // A payroll payment.
  mv('L3', -20000, 'liability', 'payroll_liability', 20000, 0),
  // An unclassifiable contra falls to other operating.
  mv('L4', -3000, 'liability', null, 3000, 0),
  // Investing and financing.
  mv('L5', -10000, 'asset', 'fixed_assets', 10000, 0),
  mv('L6', 5000, 'equity', 'equity', 0, 5000),
];

describe('cashFlowDirectService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns correct section totals', async () => {
    mockSql.mockResolvedValueOnce(OPENING_ROWS).mockResolvedValueOnce(LEG_ROWS);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.periodStart).toBe(PERIOD_START);
    expect(result.periodEnd).toBe(PERIOD_END);
    expect(result.openingCash).toBeCloseTo(15000, 2);
    expect(result.operatingTotal).toBeCloseTo(12000, 2);
    expect(result.investingTotal).toBeCloseTo(-10000, 2);
    expect(result.financingTotal).toBeCloseTo(5000, 2);
    expect(result.closingCash).toBeCloseTo(22000, 2);
  });

  it('counts a journal\'s cash once however many legs explain it', async () => {
    mockSql.mockResolvedValueOnce(OPENING_ROWS).mockResolvedValueOnce(LEG_ROWS);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    const customers = result.operatingItems.find(i => i.cashGroup === 'cash_received_from_customers');
    // L1 appears on two rows carrying net_cash 80000. Summing per row gives
    // 160000; the correct answer is 80000.
    expect(customers?.amount).toBeCloseTo(80000, 2);
  });

  it('exposes line items for each operating group', async () => {
    mockSql.mockResolvedValueOnce(OPENING_ROWS).mockResolvedValueOnce(LEG_ROWS);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    const employees = result.operatingItems.find(i => i.cashGroup === 'cash_paid_to_employees');
    expect(employees?.amount).toBeCloseTo(-20000, 2);

    const suppliers = result.operatingItems.find(i => i.cashGroup === 'cash_paid_to_suppliers');
    expect(suppliers?.amount).toBeCloseTo(-45000, 2);
  });

  it('net change always equals the sum of the three activity totals', async () => {
    mockSql.mockResolvedValueOnce(OPENING_ROWS).mockResolvedValueOnce(LEG_ROWS);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.netChange).toBeCloseTo(
      result.operatingTotal + result.investingTotal + result.financingTotal,
      2,
    );
    expect(result.closingCash).toBeCloseTo(result.openingCash + result.netChange, 2);
  });

  it('returns zero cash when no cash movements exist', async () => {
    mockSql
      .mockResolvedValueOnce([
        { id: 'bank-1', account_code: '1110', account_name: 'Bank', is_active: true,
          account_type: 'asset', gl_debit: 0, gl_credit: 0, posted_through: null },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.openingCash).toBe(0);
    expect(result.operatingTotal).toBe(0);
    expect(result.closingCash).toBe(0);
  });

  it('logs error and re-throws on DB failure', async () => {
    mockSql.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END)
    ).rejects.toThrow('timeout');
  });

  it('logs the failure by its class and SQLSTATE, never the driver\'s sentence', async () => {
    // The board pack degrades on this failure, so it is logged on every
    // degraded render — and a node-postgres message carries whatever the
    // server put in it, the statement and its values included.
    const driverError = Object.assign(
      new Error("canceling statement due to statement timeout: SELECT … WHERE company_id = 'c1'"),
      { code: '57014' },
    );
    mockSql.mockRejectedValueOnce(driverError);

    await expect(getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END)).rejects.toBe(driverError);

    const logged = vi.mocked(log.error).mock.calls.at(-1)!;
    expect(logged[1]).toEqual({ error: 'Error (SQLSTATE 57014)' });
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toMatch(/SELECT|company_id|canceling/);
  });
});
