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
// R-035 PR5 (D2): whether a hand-keyed line may pay a supplier is proved against
// real PostgreSQL (r035-pr5-manual); here it lets the path under test run.
vi.mock('@/modules/accounting/services/ap/bankLinePaymentGate', () => ({
  assertBankLineMayPaySupplier: vi.fn().mockResolvedValue(undefined),
  isBankEvidenced: () => true,
  manualLinePaymentRefusal: vi.fn().mockResolvedValue(null),
}));
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
    id: 'btx-1', status: 'imported', feed_state: 'posted', matched_journal_line_id: null,
  })),
  BankTransactionLockTimeoutError: class extends Error {},
}));
vi.mock('@/modules/accounting/services/gl/ruleVatResolution', () => ({
  resolveRuleVatCode: vi.fn(async () => ({ vatCode: 'none', denied: false, nonSupplyCoerced: false })),
}));
vi.mock('@/modules/accounting/services/ap/supplierRefundDocument', () => ({
  planSupplierRefund: vi.fn(async () => ({
    amount: 0, onAccountCredit: 1e9, supplierName: 'Acme',
  })),
  recordSupplierRefund: vi.fn(async () => ({
    paymentId: 'refund-1', amount: 0, onAccountCredit: 1e9,
  })),
}));
vi.mock('@/modules/accounting/services/ar/customerRefundDocument', () => ({
  planCustomerRefund: vi.fn(async () => ({ amount: 0, onAccountCredit: 1e9, customerName: 'Beta' })),
  recordCustomerRefund: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierAutoAllocate', () => ({
  recordSupplierBankPayment: vi.fn(async () => ({
    paymentId: 'sp-1', appliedLines: [], unappliedRemainder: 0, strategy: 'off',
  })),
}));

import { sql } from '@/lib/neon';
import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import { planSupplierRefund, recordSupplierRefund } from '@/modules/accounting/services/ap/supplierRefundDocument';
import { planCustomerRefund } from '@/modules/accounting/services/ar/customerRefundDocument';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { autoPostRuleLine } from '@/modules/accounting/services/bank/bankRuleAutoPostLine';
import { lockBankTransactionForUpdate } from '@/modules/accounting/services/bank/bankTxLock';

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

  it('creates NOTHING when the bank journal line cannot be found', async () => {
    // No bank line means no `matched_journal_line_id`, so the transaction stays
    // `imported` — and a `processed` payment against a line still open for
    // allocation is a double-document waiting to happen: re-allocating it posts
    // a second journal and creates a second payment for the same cash. The
    // document is therefore created INSIDE the block that stamps the line.
    mockSql.mockResolvedValue([]);

    const result = await autoPostRuleLine(input());

    expect(result).toMatchObject({ kind: 'posted' });
    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
  });

  it('creates a REFUND document for money in, never a payment document', async () => {
    await autoPostRuleLine(input({
      tx: {
        id: 'btx-1', amount: 500, transaction_date: '2026-09-08',
        description: 'ACME refund', bank_account_id: BANK_GL,
      },
    }));

    // The unattended sweep had the same hole as the attended path: it could
    // post a supplier deposit and left no document behind any of it.
    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
    expect(recordSupplierRefund).toHaveBeenCalledOnce();
    expect(vi.mocked(recordSupplierRefund).mock.calls[0]![0]).toMatchObject({
      supplierId: SUPPLIER, bankTxId: 'btx-1', amount: 500,
    });
    // No `autoApply` at ANY value the rule carries: a negative remainder
    // applied to a bill un-pays it.
    expect(vi.mocked(recordSupplierRefund).mock.calls[0]![0]).not.toHaveProperty('autoApply');
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

describe('autoPostRuleLine — feed-state guard', () => {
  it('returns { kind: "raced" } and issues no INSERT/UPDATE for a pending feed row', async () => {
    // findMatchingTxs read the candidate possibly seconds ago; the lock SELECT
    // is the only re-check before this would post a journal. A row still
    // pending at the bank must be treated exactly like a row raced by a
    // concurrent allocation — see the DB backstop this guards ahead of
    // (migration 675) and bankFeedStateGuard.ts.
    vi.mocked(lockBankTransactionForUpdate).mockResolvedValueOnce({
      id: 'btx-1', status: 'imported', matched_journal_line_id: null, feed_state: 'pending',
    } as never);

    const result = await autoPostRuleLine(input());

    expect(result).toEqual({ kind: 'raced' });
    expect(recordSupplierBankPayment).not.toHaveBeenCalled();
    const texts = vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
    expect(texts.some((t) => /\bINSERT\b|(?<!FOR )\bUPDATE\b/i.test(t))).toBe(false);
  });
});

/** The refund ceiling's refusal, as the sweep classifies it (isSupplierRefundRefusal reads the code). */
const ceiling = (msg: string) => Object.assign(new Error(msg), { code: 'SUPPLIER_REFUND_REFUSED' });

describe('a rule refund past the contact\'s credit is refused BEFORE the journal', () => {
  it('supplier refund (money in): planSupplierRefund refuses, no journal is created', async () => {
    vi.mocked(planSupplierRefund).mockRejectedValueOnce(ceiling('A refund of 500.00 exceeds the 0.00 Acme has on account'));
    await expect(autoPostRuleLine(input({ tx: { id: 'btx-1', amount: 500, transaction_date: '2026-09-08', description: 'ACME REFUND', bank_account_id: BANK_GL } }) as never))
      .rejects.toThrow(/exceeds the 0\.00 Acme has on account/);
    expect(vi.mocked(planSupplierRefund).mock.calls[0]!.slice(0, 3)).toEqual([COMPANY, SUPPLIER, 500]);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('customer refund (money out): planCustomerRefund refuses, no journal is created', async () => {
    vi.mocked(planCustomerRefund).mockRejectedValueOnce(ceiling('A refund of 500.00 exceeds the 0.00 Beta has on account'));
    const CUSTOMER = '66666666-6666-4666-8666-666666666666';
    await expect(autoPostRuleLine(input({
      allocType: 'customer', supplierId: null, supplierName: null, customerName: 'Beta', arAccountId: AP_ACCOUNT,
      rule: { id: 'rule-2', description_template: null, client_id: CUSTOMER },
    }) as never)).rejects.toThrow(/exceeds the 0\.00 Beta has on account/);
    expect(vi.mocked(planCustomerRefund).mock.calls[0]!.slice(0, 3)).toEqual([COMPANY, CUSTOMER, 500]);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });
});

