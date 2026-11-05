/**
 * recordLoanPayment's bank: the supplied bankAccountId (checked) → the loan's
 * own bank_account_id → the bank-role holder. Never the literal code 1110.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let loanRow: Record<string, unknown> = {};
const writes: string[] = [];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('FROM loans WHERE')) return [loanRow];
    if (q.includes('FROM loan_schedule_rows')) return [{ interest: '1000', opening: '120000', closing: '110500', installment: '10500', period: 1 }];
    if (q.includes('INSERT INTO loan_payments')) { writes.push('payment'); return [{ id: 'pay-1' }]; }
    return [];
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const createJournalEntry = vi.fn(async (..._args: unknown[]) => { writes.push('journal'); return { id: 'je-1' }; });
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: (...a: unknown[]) => createJournalEntry(...a),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn(async () => undefined) }));
const resolvePaymentBankAccount = vi.fn();
vi.mock('@/modules/accounting/services/gl/paymentBankAccount', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/paymentBankAccount')>()),
  resolvePaymentBankAccount: (...a: unknown[]) => resolvePaymentBankAccount(...a),
}));

import { BankAccountRefusedError } from '@/modules/accounting/services/gl/paymentBankAccount';
import { recordLoanPayment } from '@/modules/accounting/services/loans/loanPaymentService';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const LOAN = 'dddddddd-0000-4000-8000-000000000002';
const USER = 'cccccccc-0000-4000-8000-000000000003';

beforeEach(() => {
  writes.length = 0; createJournalEntry.mockClear(); resolvePaymentBankAccount.mockReset();
  loanRow = { id: LOAN, status: 'active', reference: 'L1', gl_account_id: 'acct-loan', interest_expense_account_id: 'acct-interest', bank_account_id: null };
});

const credited = (): string => {
  const input = createJournalEntry.mock.calls[0]![1] as { lines: Array<{ glAccountId: string; credit: number }> };
  return input.lines.find((l) => l.credit > 0)!.glAccountId;
};
const pay = (bankAccountId?: string) => recordLoanPayment(CO, LOAN, { paymentDate: '2026-02-01', periodNumber: 1, bankAccountId }, USER);

describe('recordLoanPayment — which bank it credits', () => {
  it('nothing supplied, loan has no bank: the bank-role holder', async () => {
    resolvePaymentBankAccount.mockResolvedValue('acct-holder');
    await pay();
    expect(resolvePaymentBankAccount.mock.calls[0]!.slice(0, 2)).toEqual([CO, undefined]);
    expect(credited()).toBe('acct-holder');
  });

  it('nothing supplied, the loan names its bank: the loan\'s bank, checked like a supplied one', async () => {
    loanRow.bank_account_id = 'acct-loan-bank';
    resolvePaymentBankAccount.mockResolvedValue('acct-loan-bank');
    await pay();
    expect(resolvePaymentBankAccount).toHaveBeenCalledTimes(1);
    expect(resolvePaymentBankAccount.mock.calls[0]!.slice(0, 2)).toEqual([CO, 'acct-loan-bank']);
    expect(credited()).toBe('acct-loan-bank');
  });

  it('the loan\'s stored bank is refused (deactivated, not a bank, other company): nothing is written', async () => {
    loanRow.bank_account_id = 'acct-loan-bank';
    resolvePaymentBankAccount.mockRejectedValue(new BankAccountRefusedError('1110 Bank is deactivated'));
    await expect(pay()).rejects.toBeInstanceOf(BankAccountRefusedError);
    expect(writes).toEqual([]);
  });

  it('a supplied bankAccountId is checked and beats the loan\'s bank', async () => {
    loanRow.bank_account_id = 'acct-loan-bank';
    resolvePaymentBankAccount.mockResolvedValue('acct-checked');
    await pay('some-id');
    expect(resolvePaymentBankAccount.mock.calls[0]!.slice(0, 2)).toEqual([CO, 'some-id']);
    expect(credited()).toBe('acct-checked');
  });

  it('a refusal writes nothing', async () => {
    resolvePaymentBankAccount.mockRejectedValue(new BankAccountRefusedError('not a bank account'));
    await expect(pay('some-id')).rejects.toBeInstanceOf(BankAccountRefusedError);
    expect(writes).toEqual([]);
  });
});
