/**
 * The bank account the UIF, SARS directive and loan payments credit.
 *
 * They defaulted to the literal code 1110 and trusted any `bankAccountId` the
 * request named. The default is now the bank-role holder (the same resolution
 * as payroll's net pay), and a supplied id must be an active, postable bank
 * account of THIS company. Refusals are BankAccountRefusedError, raised before
 * the caller writes anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import {
  answerHeaderGuard, glAccount, selectGlAccounts, type GlAccountRow,
} from '../../../helpers/glAccountsTableMock';

let table: GlAccountRow[] = [];
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise.resolve(
    strings.join('?').includes('parent_account_id') ? answerHeaderGuard(table, strings, values) : selectGlAccounts(table, strings, values)),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const getSystemAccount = vi.fn();
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: (...args: unknown[]) => getSystemAccount(...args),
}));

import {
  BankAccountRefusedError, isBankAccountRefusal, resolvePaymentBankAccount,
} from '@/modules/accounting/services/gl/paymentBankAccount';

const CO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BANK = id(1), OLD = id(2), CURRENT_ACCT = id(3), THEIRS = id(4), HEADER = id(5), CHILD = id(6), DEACT = id(7);

const row = (accountId: string, code: string, over: Partial<GlAccountRow> = {}, company = CO) =>
  glAccount({ id: accountId, company_id: company, account_code: code, account_name: `Acct ${code}`, ...over });
const holder = (accountId: string, code: string) => ({ id: accountId, accountCode: code, accountName: `Acct ${code}` });

beforeEach(() => {
  getSystemAccount.mockReset();
  table = [
    row(BANK, '1544331', { account_subtype: 'bank', is_system_account: true }),
    row(OLD, '1110', { account_subtype: 'bank', is_system_account: false, is_active: false }),
    row(CURRENT_ACCT, '1120', { account_subtype: 'bank' }),
    row(THEIRS, '1110', { account_subtype: 'bank', is_system_account: true }, OTHER),
    row(HEADER, '1130', { account_subtype: 'bank', level: 1 }),
    row(CHILD, '1131', { account_subtype: 'bank', parent_account_id: HEADER, level: 2 }),
    row(DEACT, '1140', { account_subtype: 'bank', is_active: false }),
    row(id(8), '2150', { account_type: 'liability', account_subtype: 'other' }),
  ];
});

describe('resolvePaymentBankAccount — no bankAccountId supplied', () => {
  it('is the bank-role holder, not the code 1110', async () => {
    getSystemAccount.mockResolvedValue(holder(BANK, '1544331'));
    await expect(resolvePaymentBankAccount(CO)).resolves.toBe(BANK);
    expect(getSystemAccount).toHaveBeenCalledWith('bank', CO);
  });

  it('refuses with a named error, never falling back to 1110, when no account holds the role', async () => {
    getSystemAccount.mockRejectedValue(new MissingSystemAccountError('bank', CO, 'deactivated_claimants_only', []));
    const err = await resolvePaymentBankAccount(CO).catch((e: unknown) => e);
    expect(isBankAccountRefusal(err)).toBe(true);
    expect((err as BankAccountRefusedError).message).toMatch(/bank role/);
    expect((err as BankAccountRefusedError).message).toMatch(/Default Accounts/);
  });

  it('refuses when two active accounts claim the role', async () => {
    table.push(row(id(9), '1555', { account_subtype: 'bank', is_system_account: true }));
    getSystemAccount.mockResolvedValue(holder(BANK, '1544331'));
    const err = await resolvePaymentBankAccount(CO).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/More than one active account/);
    expect((err as Error).message).toContain('1555');
    expect((err as Error).message).toContain('1544331');
  });

  it('refuses a holder deactivated since the resolver cached it', async () => {
    table = table.map((r) => (r.id === BANK ? { ...r, is_active: false } : r));
    getSystemAccount.mockResolvedValue(holder(BANK, '1544331'));
    await expect(resolvePaymentBankAccount(CO)).rejects.toThrow(/deactivated/);
  });

  it('refuses a role that moved within the resolver cache window', async () => {
    getSystemAccount.mockResolvedValue(holder(OLD, '1110'));
    await expect(resolvePaymentBankAccount(CO)).rejects.toThrow(/no longer holds/);
  });

  it('propagates a failure that is not a missing role', async () => {
    getSystemAccount.mockRejectedValue(new Error('connection terminated'));
    await expect(resolvePaymentBankAccount(CO)).rejects.toThrow('connection terminated');
  });
});

describe('resolvePaymentBankAccount — a caller-supplied bankAccountId', () => {
  it('accepts an active bank account of this company, role holder or not', async () => {
    await expect(resolvePaymentBankAccount(CO, CURRENT_ACCT)).resolves.toBe(CURRENT_ACCT);
    expect(getSystemAccount).not.toHaveBeenCalled();
  });

  it('accepts every spelling of the bank subtype the chart vocabulary knows (bank_account)', async () => {
    table.push(row(id(10), '1150', { account_subtype: 'bank_account' }));
    await expect(resolvePaymentBankAccount(CO, id(10))).resolves.toBe(id(10));
  });

  it('refuses an account of another company', async () => {
    await expect(resolvePaymentBankAccount(CO, THEIRS)).rejects.toThrow(/not an account of this company/);
  });

  it('refuses an account that is not a bank account', async () => {
    await expect(resolvePaymentBankAccount(CO, id(8))).rejects.toThrow(/2150 Acct 2150 is not a bank account/);
  });

  it.each(['bank', 'bank_account'])('refuses a liability carrying the %s subtype (a credit card is no bank)', async (account_subtype) => {
    table.push(row(id(11), '2160', { account_type: 'liability', account_subtype }));
    await expect(resolvePaymentBankAccount(CO, id(11))).rejects.toThrow(/2160 Acct 2160 is not a bank account/);
  });

  it('refuses a deactivated bank account', async () => {
    await expect(resolvePaymentBankAccount(CO, DEACT)).rejects.toThrow(/1140 Acct 1140 is deactivated/);
  });

  it('refuses a bank header with sub-accounts, as the poster would', async () => {
    await expect(resolvePaymentBankAccount(CO, HEADER)).rejects.toThrow(/is a header with sub-accounts/);
  });

  it('refuses an id that is not a UUID before it reaches a cast', async () => {
    await expect(resolvePaymentBankAccount(CO, 'not-a-uuid')).rejects.toThrow(/valid UUID/);
  });

  it('refuses an unknown id', async () => {
    await expect(resolvePaymentBankAccount(CO, id(99))).rejects.toThrow(/not an account of this company/);
  });
});

describe('resolvePaymentBankAccount — a loan\'s STORED bank (requireBankSubtype: false)', () => {
  const STORED = { requireBankSubtype: false };
  const what = "The loan's bank account";

  it('accepts an active postable account of this company whatever its subtype (cash, other, NULL)', async () => {
    table.push(row(id(20), '1160', { account_subtype: 'cash' }), row(id(21), '1161', { account_subtype: null }), row(id(22), '1162', { account_subtype: 'other' }));
    for (const acct of [id(20), id(21), id(22)]) {
      await expect(resolvePaymentBankAccount(CO, acct, what, STORED)).resolves.toBe(acct);
    }
  });

  it('still refuses another company, a deactivated account, a header and a non-UUID, naming the loan\'s account', async () => {
    await expect(resolvePaymentBankAccount(CO, THEIRS, what, STORED)).rejects.toThrow(/The loan's bank account is not an account of this company/);
    await expect(resolvePaymentBankAccount(CO, DEACT, what, STORED)).rejects.toThrow(/1140 Acct 1140 is deactivated/);
    await expect(resolvePaymentBankAccount(CO, HEADER, what, STORED)).rejects.toThrow(/is a header with sub-accounts/);
    await expect(resolvePaymentBankAccount(CO, 'nope', what, STORED)).rejects.toThrow(/The loan's bank account must be a valid UUID/);
  });

  it.each(['revenue', 'expense', 'liability'])('refuses a stored id that is a %s account, in the bank-account wording', async (account_type) => {
    table.push(row(id(30), '4000', { account_type, account_subtype: null }));
    await expect(resolvePaymentBankAccount(CO, id(30), what, STORED)).rejects.toThrow(/4000 Acct 4000 is not a bank account/);
    const err = await resolvePaymentBankAccount(CO, id(30), what, STORED).catch((e: unknown) => e);
    expect(isBankAccountRefusal(err)).toBe(true);
  });

  it('a caller-supplied id (the default) still demands the bank subtype', async () => {
    await expect(resolvePaymentBankAccount(CO, id(8), what)).rejects.toThrow(/is not a bank account/);
  });
});
