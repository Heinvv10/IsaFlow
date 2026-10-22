/**
 * bank_accounts export — every figure comes from the service that owns it
 * (status list, cash.balance.v1, reconciliations); this checks the joining:
 * column order, the masked number, a blank Ledger_Balance for an account the
 * cash figure does not hold (never a second definition), the latest statement
 * on any reconciliation vs the latest COMPLETED one, inactive accounts kept,
 * and the summary over the rows.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

const status = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({ getBankAccountsStatus: status }));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({
  getCashBalance: vi.fn(async () => ({
    asAt: '2026-10-22', total: 1000.5,
    accounts: [
      { accountId: 'aaaaaaaa-0000-4000-8000-000000000001', glBalance: 48986.88 },
      { accountId: 'bbbbbbbb-0000-4000-8000-000000000002', glBalance: -12.34 },
    ],
    deactivatedWithBalance: [], postedThrough: null,
  })),
}));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({
  getReconciliations: vi.fn(async () => [
    { bankAccountId: 'aaaaaaaa-0000-4000-8000-000000000001', statementDate: '2026-08-24', statementBalance: 10, status: 'completed' },
    { bankAccountId: 'aaaaaaaa-0000-4000-8000-000000000001', statementDate: '2026-09-24', statementBalance: 20, status: 'completed' },
    { bankAccountId: 'aaaaaaaa-0000-4000-8000-000000000001', statementDate: '2026-10-24', statementBalance: 30, status: 'in_progress' },
    { bankAccountId: 'bbbbbbbb-0000-4000-8000-000000000002', statementDate: '2026-09-30', statementBalance: 5, status: 'in_progress' },
  ]),
}));

import { buildBankAccounts, BANK_ACCOUNTS_COLUMNS, maskAccountNumber } from '@/modules/accounting/services/reports/bankAccountsExport';

function acct(id: string, code: string, number: string | null, isActive: boolean, unrec: number, unalloc: number, last: string | null) {
  return {
    id, accountCode: code, accountName: `Bank ${code}`, bankAccountNumber: number, isActive,
    unreconciledCount: unrec, unallocatedCount: unalloc, lastDate: last,
  };
}

describe('bank_accounts export', () => {
  it('joins the owning services per account, in Bank_Account_ID order, with the fixed columns', async () => {
    status.mockResolvedValue([
      acct(C, '1544999', null, true, 0, 0, null),
      acct(B, '1560731', '4118 8196 18', false, 3, 1, '2026-10-09'),
      acct(A, '1544331', '4118819618', true, 12, 1, '2026-10-10'),
    ]);
    const out = await buildBankAccounts('11111111-1111-4111-8111-111111111111', '2026-10-22');
    expect(status).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', { includeInactive: true });
    expect(out.columns).toEqual(BANK_ACCOUNTS_COLUMNS);
    expect(BANK_ACCOUNTS_COLUMNS).toEqual([
      'Bank_Account_ID', 'GL_Account_Code', 'Name', 'Account_Number_Masked', 'Currency', 'Ledger_Balance',
      'Last_Statement_Date', 'Last_Statement_Closing_Balance', 'Last_Reconciled_Date',
      'Unreconciled_Line_Count', 'Unallocated_Line_Count', 'Last_Transaction_Date', 'Is_Active', 'Schema_Version',
    ]);
    expect(out.rows.map((r) => r.Bank_Account_ID)).toEqual([A, B, C]);
    expect(out.rows[0]).toMatchObject({
      Account_Number_Masked: '****9618', Currency: 'ZAR', Ledger_Balance: 48986.88,
      Last_Statement_Date: '2026-10-24', Last_Statement_Closing_Balance: 30, Last_Reconciled_Date: '2026-09-24',
      Unreconciled_Line_Count: 12, Unallocated_Line_Count: 1, Last_Transaction_Date: '2026-10-10', Is_Active: true,
    });
    expect(out.rows[1]).toMatchObject({ Is_Active: false, Last_Reconciled_Date: null, Last_Statement_Date: '2026-09-30' });
    // Not held by cash.balance.v1: blank, not zero.
    expect(out.rows[2]).toMatchObject({ Ledger_Balance: null, Account_Number_Masked: null, Last_Statement_Date: null });
    expect(out.summary).toMatchObject({
      table: 'bank_accounts', asAt: '2026-10-22', rowCount: 3, controlTotal: 48974.54,
      noLedgerBalanceCount: 1, unreconciledLineCount: 15, unallocatedLineCount: 2,
    });
  });

  it('masks to the last four characters', () => {
    expect(maskAccountNumber('4118 8196 18')).toBe('****9618');
    expect(maskAccountNumber('12')).toBe('****12');
    expect(maskAccountNumber('  ')).toBeNull();
    expect(maskAccountNumber(null)).toBeNull();
  });
});
