/**
 * The rule sweep creates the supplier payment document for the cash it posts.
 *
 * THE GAP THIS CLOSES. `autoPostRuleLine` does NOT call `allocateTransaction`
 * — it builds and posts its own journal. So the payment document that path
 * creates was never created here: a sweep could debit Accounts Payable
 * hundreds of times and leave no supplier payment behind any of it. That cash
 * sits on the control account where no report and no apply tool can reach it,
 * and this is the HIGHEST-VOLUME path in the system, with no human watching it.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  return { sql: vi.fn(async () => []), fmtDate: actual.fmtDate };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
  postJournalEntry: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: vi.fn(async () => 'open'),
}));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({
  lockBankTransactionForUpdate: vi.fn(async () => ({
    id: 'btx-1', status: 'imported', matched_journal_line_id: null,
  })),
  BankTransactionLockTimeoutError: class extends Error {},
}));
vi.mock('@/modules/accounting/services/gl/ruleVatResolution', () => ({
  resolveRuleVatCode: vi.fn(async () => ({ vatCode: 'none', denied: false, nonSupplyCoerced: false })),
}));
vi.mock('@/modules/accounting/services/ap/supplierAutoAllocate', () => ({
  recordSupplierBankPayment: vi.fn(async () => ({
    paymentId: 'sp-1', appliedLines: [], unappliedRemainder: 0, strategy: 'off',
  })),
}));

import { sql } from '@/lib/neon';
import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { autoPostRuleLine } from '@/modules/accounting/services/bank/bankRuleAutoPostLine';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const BANK_GL = '33333333-3333-4333-8333-333333333333';
const AP_ACCOUNT = '44444444-4444-4444-8444-444444444444';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;

/** A payment OUT of R500 matched by a supplier rule. */
function input(over: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY,
    userId: '55555555-5555-4555-8555-555555555555',
    tx: {
      id: 'btx-1', amount: -500, transaction_date: '2026-09-08',
      description: 'ACME EFT', bank_account_id: BANK_GL,
    },
    rule: { id: 'rule-1', description_template: null },
    ruleName: 'ACME',
    allocType: 'supplier',
    ruleGlAccountId: null,
    bankGlAccountId: BANK_GL,
    apAccountId: AP_ACCOUNT,
    arAccountId: null,
    supplierName: 'Acme Supplies',
    supplierId: SUPPLIER,
    customerName: null,
    ...over,
  } as unknown as Parameters<typeof autoPostRuleLine>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  // The bank journal-line lookup, then the bank_transactions UPDATE.
  mockSql.mockResolvedValue([{ id: 'jl-1' }]);
});

describe('autoPostRuleLine — supplier', () => {
  it('creates the payment document for the cash it just posted', async () => {
    const result = await autoPostRuleLine(input());

    expect(result).toMatchObject({ kind: 'posted', journalEntryId: 'je-1' });
    expect(recordSupplierBankPayment).toHaveBeenCalledOnce();
    expect(vi.mocked(recordSupplierBankPayment).mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY,
      supplierId: SUPPLIER,
      bankTxId: 'btx-1',
      bankAccountId: BANK_GL,
      // The document must carry the journal THIS function posted, or a
      // reversal cannot find the pair.
      journalEntryId: 'je-1',
      amount: 500,
      paymentDate: '2026-09-08',
    });
  });

  it('creates nothing for a REFUND — money in is not a payment', async () => {
    await autoPostRuleLine(input({
      tx: {
        id: 'btx-1', amount: 500, transaction_date: '2026-09-08',
        description: 'ACME refund', bank_account_id: BANK_GL,
      },
    }));

    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
  });

  it('creates nothing when the rule names no supplier', async () => {
    await autoPostRuleLine(input({ supplierId: null }));
    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
  });

  it('creates nothing on an account-type rule', async () => {
    await autoPostRuleLine(input({
      allocType: 'account', supplierId: null, ruleGlAccountId: 'gl-1', apAccountId: null,
    }));
    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
  });
});
