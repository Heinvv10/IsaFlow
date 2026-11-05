/**
 * markUifDeclarationPaid credits the bank account `resolvePaymentBankAccount`
 * names (the supplied bankAccountId, checked, else the bank-role holder), not
 * the literal code 1110, and resolves it BEFORE the declaration is claimed so a
 * refusal leaves the declaration 'submitted' and writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const writes: string[] = [];
let declStatus = 'submitted';
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (/UPDATE uif_declarations SET status/.test(q)) { writes.push('claim'); return declStatus === 'submitted' ? [{ id: DECL }] : []; }
    if (/UPDATE uif_declarations SET journal_entry_id/.test(q)) { writes.push('link'); return []; }
    if (q.includes('FROM uif_declarations')) {
      return [{ id: DECL, company_id: CO, period_year: 2026, period_month: 10, status: declStatus,
        total_employee_contribution: 100, total_employer_contribution: 100 }];
    }
    return [];
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/documentClaimLock', () => ({
  claimUnderLockTimeout: async (_kind: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  getAccountByCode: vi.fn(async (_co: string, code: string) => ({ id: `acct-${code}` })),
}));
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
import { markUifDeclarationPaid } from '@/modules/accounting/services/payroll/uifPaymentService';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const DECL = 'dddddddd-0000-4000-8000-000000000002';
const USER = 'cccccccc-0000-4000-8000-000000000003';

beforeEach(() => { declStatus = 'submitted'; writes.length = 0; createJournalEntry.mockClear(); resolvePaymentBankAccount.mockReset(); });

const creditedAccount = (): string => {
  const input = createJournalEntry.mock.calls[0]![1] as { lines: Array<{ glAccountId: string; credit: number }> };
  return input.lines.find((l) => l.credit > 0)!.glAccountId;
};

describe('markUifDeclarationPaid — which bank it credits', () => {
  it('no bankAccountId: credits the account the resolver names (the bank-role holder), not 1110', async () => {
    resolvePaymentBankAccount.mockResolvedValue('acct-holder');
    await markUifDeclarationPaid(CO, DECL, {}, USER);
    expect(resolvePaymentBankAccount).toHaveBeenCalledWith(CO, undefined);
    expect(creditedAccount()).toBe('acct-holder');
  });

  it('a supplied bankAccountId goes through the resolver for checking, and the checked id is credited', async () => {
    resolvePaymentBankAccount.mockResolvedValue('acct-checked');
    await markUifDeclarationPaid(CO, DECL, { bankAccountId: 'some-id' }, USER);
    expect(resolvePaymentBankAccount).toHaveBeenCalledWith(CO, 'some-id');
    expect(creditedAccount()).toBe('acct-checked');
  });

  it('a refusal happens before the declaration is claimed: nothing is written', async () => {
    resolvePaymentBankAccount.mockRejectedValue(new BankAccountRefusedError('No active account holds the company\'s bank role.'));
    await expect(markUifDeclarationPaid(CO, DECL, {}, USER)).rejects.toBeInstanceOf(BankAccountRefusedError);
    expect(writes).toEqual([]);
  });
});

describe('markUifDeclarationPaid — a retry on an already-paid declaration', () => {
  it('returns the idempotent result without consulting the bank resolver, even if it would now refuse', async () => {
    declStatus = 'paid';
    resolvePaymentBankAccount.mockRejectedValue(new BankAccountRefusedError('the role moved'));
    const out = await markUifDeclarationPaid(CO, DECL, { bankAccountId: 'deactivated-since' }, USER);
    expect(out.status).toBe('paid');
    expect(resolvePaymentBankAccount).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
