/**
 * K-071 r15 — the rule sweep skips EVERY contention event, not only the
 * bank-line lock.
 *
 * `applyRules` runs each candidate inside `withSavepoint('rule_autopost_line')`.
 * A supplier rule reaches `recordSupplierBankPayment` →
 * `planSupplierPaymentApplication`, whose plan phase raises the payment-lock
 * timeout and a `retryable` refusal for a held bill. (The receipt refusal is
 * pinned too: the sweep takes the whole union.) Those arrive through a
 * savepoint that rolled back CLEANLY, so the request transaction is still
 * live. The catch used to skip only
 * `BankTransactionLockTimeoutError` and re-throw the other three, and the
 * route's 400 then COMMITted every line the sweep had already posted.
 *
 * Both directions: each union member is counted and the run continues; a
 * books refusal and a plain Error still end the run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, autoPostMock, findTxsMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  autoPostMock: vi.fn(),
  findTxsMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withSavepoint: vi.fn(async (_name: string, cb: () => unknown) => cb()),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async (k: string) => `acct-${k}`),
}));
vi.mock('@/modules/accounting/services/gl/inputVatDenial', () => ({
  fetchVatDenialFlags: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/gl/nonSupplyVatGuard', () => ({
  fetchAccountNames: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/gl/bankContraVat', () => ({
  fetchBankContraFlags: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/bank/bankRulesMatchingHelpers', () => ({
  toSqlPattern: vi.fn((_m: string, p: string) => p),
  findMatchingTxs: findTxsMock,
  MAX_RULE_CANDIDATES: 500,
}));
vi.mock('@/modules/accounting/services/bank/bankRuleAutoPostLine', () => ({
  autoPostRuleLine: autoPostMock,
}));

import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';
import { PaymentLockTimeoutError } from '@/modules/accounting/services/core/paymentLock';
import { ReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const BANK_GL = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  autoPostMock.mockReset();
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('FROM bank_categorisation_rules')) {
      return Promise.resolve([{
        id: 'rule-1', rule_name: 'Bank charges', priority: 1, auto_create_entry: true,
        gl_account_id: 'acct-charges', match_field: 'description',
        match_type: 'contains', match_pattern: 'FEE', vat_code: 'none',
      }]);
    }
    if (text.includes('FROM gl_accounts')) return Promise.resolve([{ id: BANK_GL }]);
    return Promise.resolve([]);
  }) as never);
  findTxsMock.mockResolvedValue([
    { id: 'tx-1', transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE' },
    { id: 'tx-2', transaction_date: '2026-08-14', amount: -200, description: 'BANK FEE' },
  ]);
});

const CONTENTION: Array<[string, () => Error]> = [
  ['the bank-line lock', () => new BankTransactionLockTimeoutError('tx-1')],
  ['the payment lock', () => new PaymentLockTimeoutError('pay-1')],
  ['a held bill', () => new SupplierPaymentRefusal(
    'Another request is paying one of these bills — retry in a moment.', { retryable: true })],
  ['a held invoice', () => new ReceiptRefusal(
    'Another request is applying cash to one of these invoices — retry in a moment.', { retryable: true })],
];

describe('applyRules — a contended candidate is counted, and the run goes on', () => {
  it.each(CONTENTION)('skips %s and still posts the next candidate', async (_label, make) => {
    autoPostMock
      .mockRejectedValueOnce(make())
      .mockResolvedValueOnce({ kind: 'posted', journalEntryId: 'je-2' });

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(result.autoPostSkippedLocked).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.entries).toEqual([{ bankTxId: 'tx-2', ruleName: 'Bank charges', journalEntryId: 'je-2' }]);
    expect(autoPostMock).toHaveBeenCalledTimes(2);
  });
});

describe('applyRules — anything that is not contention still ends the run', () => {
  it('re-throws a books refusal (a SupplierPaymentRefusal WITHOUT the flag)', async () => {
    const refusal = new SupplierPaymentRefusal('This bill is cancelled.');
    autoPostMock.mockRejectedValueOnce(refusal);

    await expect(applyRules(COMPANY, BANK_GL, USER)).rejects.toBe(refusal);
    expect(autoPostMock).toHaveBeenCalledTimes(1);
  });

  it('re-throws a plain Error', async () => {
    const boom = new Error('relation does not exist');
    autoPostMock.mockRejectedValueOnce(boom);

    await expect(applyRules(COMPANY, BANK_GL, USER)).rejects.toBe(boom);
    expect(autoPostMock).toHaveBeenCalledTimes(1);
  });
});
