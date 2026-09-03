import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-12-31';

// Opening cash now comes from cash.balance.v1's owning service
// (bank/cashBalanceService), which returns one row PER bank account with a
// `gl_balance` column. fetchOpeningCash no longer carries its own copy of the
// query — that private copy is why cash had four answers.
const OPENING_ROWS = [
  { id: 'bank-1', account_code: '1110', account_name: 'Bank', is_active: true,
    gl_balance: 15000, posted_through: null },
];

// The service issues two queries: opening cash, then every cash leg in the
// period joined to its contra lines. The second returns ONE ROW PER
// (cash leg x contra line) — the cash amount repeats and must be counted once.
// A previous version of this service summed it per contra row inside SQL,
// which double-counted every multi-line entry; see
// tests/integration/afs-cash-flow-direct.int.test.ts for the ledger tie-out.
const LEG_ROWS = [
  // One receipt of 80000 explained by two revenue lines.
  { bank_line_id: 'L1', bank_amount: 80000, contra_account_type: 'revenue', contra_account_subtype: 'sales', contra_amount: -50000 },
  { bank_line_id: 'L1', bank_amount: 80000, contra_account_type: 'revenue', contra_account_subtype: 'other_income', contra_amount: -30000 },
  // A supplier payment.
  { bank_line_id: 'L2', bank_amount: -45000, contra_account_type: 'expense', contra_account_subtype: 'operating_expense', contra_amount: 45000 },
  // A payroll payment.
  { bank_line_id: 'L3', bank_amount: -20000, contra_account_type: 'liability', contra_account_subtype: 'payroll_liability', contra_amount: 20000 },
  // An unclassifiable contra falls to other operating.
  { bank_line_id: 'L4', bank_amount: -3000, contra_account_type: 'liability', contra_account_subtype: null, contra_amount: 3000 },
  // Investing and financing.
  { bank_line_id: 'L5', bank_amount: -10000, contra_account_type: 'asset', contra_account_subtype: 'fixed_assets', contra_amount: 10000 },
  { bank_line_id: 'L6', bank_amount: 5000, contra_account_type: 'equity', contra_account_subtype: 'equity', contra_amount: -5000 },
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

  it('counts a cash leg once however many contra lines explain it', async () => {
    mockSql.mockResolvedValueOnce(OPENING_ROWS).mockResolvedValueOnce(LEG_ROWS);

    const result = await getCashFlowDirect(COMPANY_ID, PERIOD_START, PERIOD_END);

    const customers = result.operatingItems.find(i => i.cashGroup === 'cash_received_from_customers');
    // L1 appears on two rows carrying bank_amount 80000. Summing per row gives
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
          gl_balance: 0, posted_through: null },
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
});
