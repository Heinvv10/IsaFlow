// D5 (Hein, 2026-10-02): the balance-sheet / income-statement split that decides whether a role HOLDER may have
// sub-accounts now decides ASSIGNMENT too. An income-statement role (default revenue, cost of sales) may be moved onto
// an account that has sub-accounts — by the Default Accounts save, by the COA import's role map (an existing header,
// or one the same import makes), and by reactivating a former holder into an empty role; the post-condition accepts
// such a holder. A balance-sheet role (bank, receivable, payable) still may not. Disposable fixture only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { brkFixture } from './w2-28-brk593.helpers';
import coa from '../../pages/api/accounting/chart-of-accounts';
import defaultAccounts from '../../pages/api/accounting/default-accounts';
import coaImport from '../../pages/api/accounting/migration/chart-of-accounts';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { clearSystemAccountCache, getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertRolesKept, snapshotRoles, SystemRoleInvariantError } from '@/modules/accounting/services/gl/systemRoleInvariant';

const describeIfDb = process.env.DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const fx = brkFixture('W228D5');
const { CO, USER, ins, holders } = fx;
const [BANK, AR, AP, REV, EXP, RH, EH, AH, LH, RE, OBE, QH] = Array.from({ length: 12 }, () => randomUUID());
const message = (r: { body: Record<string, unknown> }) => String((r.body.error as { message?: string } | undefined)?.message ?? '');
const save = async (uiKey: string, target: string, loaded: string) => {
  const r = await fx.call(defaultAccounts, 'POST', '/api/accounting/default-accounts', { mappings: { [uiKey]: target }, loaded: { [uiKey]: loaded } });
  return { status: r.statusCode, message: message(r) };
};
const resolve = (key: string) => getSystemAccount(key as never, CO).then((a) => a.accountCode, (e: Error) => e.name);
const row = (accountCode: string, accountType: string, extra: Record<string, unknown> = {}) =>
  ({ accountCode, accountName: `Imported ${accountCode}`, accountType, normalBalance: ['asset', 'expense'].includes(accountType) ? 'debit' : 'credit', ...extra });
const importing = async (accounts: Record<string, unknown>[], systemAccountMap: Record<string, string>) => {
  const session = await createSession(CO, 'sage', USER);
  const r = await fx.call(coaImport, 'POST', '/api/accounting/migration/chart-of-accounts', { sessionId: session.id, accounts, systemAccountMap });
  const data = r.body.data as { imported?: number; errors?: { message: string }[] } | undefined;
  return { status: r.statusCode, imported: data?.imported, errors: (data?.errors ?? []).map((e) => e.message) };
};
const parentOf = async (code: string) => (await fx.query(`SELECT (SELECT p.account_code FROM gl_accounts p WHERE p.id = a.parent_account_id) AS parent
  FROM gl_accounts a WHERE company_id = $1 AND account_code = $2`, [CO, code])).rows[0]?.parent ?? null;
/** Moves a role's flag onto `to` by hand, the way a writer's own UPDATEs would, for the post-condition to judge. */
const moveFlag = async (role: string, to: string) => {
  await fx.query('UPDATE gl_accounts SET is_system_account = false WHERE company_id = $1 AND account_subtype = $2', [CO, role]);
  await fx.query('UPDATE gl_accounts SET is_system_account = true, account_subtype = $2 WHERE id = $1', [to, role]);
};

describeIfDb('D5: an income-statement role may be assigned to a header; a balance-sheet role may not', () => {
  beforeAll(fx.setup);
  beforeEach(async () => {
    await fx.wipe(); clearSystemAccountCache(CO);
    await ins(BANK, '1110', 'asset', 'bank', true);
    await ins(AR, '1120', 'asset', 'receivable', true);
    await ins(AP, '2110', 'liability', 'payable', true);
    await ins(REV, '4100', 'revenue', 'default_revenue', true);
    await ins(EXP, '5100', 'expense', 'default_expense', true);
    await ins(RE, '3100', 'equity', 'retained_earnings', true);
    await ins(OBE, '3300', 'equity', 'opening_balance_equity', true);
    // One header of each kind, each with one sub-account.
    await ins(RH, '4200', 'revenue', 'other', false, { level: 2 });
    await ins(randomUUID(), '4201', 'revenue', 'revenue', false, { parent: RH });
    await ins(EH, '5200', 'expense', 'other', false, { level: 2 });
    await ins(randomUUID(), '5201', 'expense', 'operating_expense', false, { parent: EH });
    await ins(AH, '1200', 'asset', null, false, { level: 2 });
    await ins(randomUUID(), '1201', 'asset', null, false, { parent: AH });
    await ins(LH, '2200', 'liability', null, false, { level: 2 });
    await ins(randomUUID(), '2201', 'liability', null, false, { parent: LH });
    await ins(QH, '3200', 'equity', null, false, { level: 2 });
    await ins(randomUUID(), '3201', 'equity', null, false, { parent: QH });
  });
  afterAll(fx.teardown);

  describe('the Default Accounts save', () => {
    it('moves default revenue onto a revenue account with sub-accounts: 200, and the role resolves to it', async () => {
      expect({ save: await save('sales_revenue', RH, REV), holders: await holders('default_revenue'), resolves: await resolve('default_revenue') })
        .toEqual({ save: { status: 200, message: '' }, holders: ['4200'], resolves: '4200' });
    });

    it('moves cost of sales onto an expense account with sub-accounts: 200, and the role resolves to it', async () => {
      expect({ save: await save('cost_of_sales', EH, EXP), holders: await holders('default_expense'), resolves: await resolve('default_expense') })
        .toEqual({ save: { status: 200, message: '' }, holders: ['5200'], resolves: '5200' });
    });

    it('still refuses the bank, receivable and payable roles on a header, 400, saying it is a balance-sheet rule; nothing moves', async () => {
      const out = {
        bank: await save('primary_bank', AH, BANK),
        receivable: await save('accounts_receivable', AH, AR),
        payable: await save('accounts_payable', LH, AP),
      };
      const refused = (code: string, key: string) => ({ status: 400, message: expect.stringMatching(
        new RegExp(`^Account ${code} is a header with sub-accounts, and a balance-sheet role cannot be held by a header; choose one of its sub-accounts for '${key}'$`)) });
      expect(out).toEqual({ bank: refused('1200', 'primary_bank'), receivable: refused('1200', 'accounts_receivable'), payable: refused('2200', 'accounts_payable') });
      expect({ bank: await holders('bank'), receivable: await holders('receivable'), payable: await holders('payable') })
        .toEqual({ bank: ['1110'], receivable: ['1120'], payable: ['2110'] });
    });

    it('still refuses the EQUITY roles (retained earnings, opening balance equity) on an equity header; nothing moves', async () => {
      const out = { re: await save('retained_earnings', QH, RE), obe: await save('opening_balance_equity', QH, OBE) };
      expect(out).toEqual({
        re: { status: 400, message: expect.stringMatching(/^Account 3200 is a header with sub-accounts, and a balance-sheet role cannot be held by a header/) },
        obe: { status: 400, message: expect.stringMatching(/^Account 3200 is a header with sub-accounts, and a balance-sheet role cannot be held by a header/) } });
      expect({ re: await holders('retained_earnings'), obe: await holders('opening_balance_equity') }).toEqual({ re: ['3100'], obe: ['3300'] });
    });
  });

  describe('the COA import role map', () => {
    it('maps default revenue onto an EXISTING revenue header: imported, the role resolves to it', async () => {
      const out = await importing([row('4200', 'revenue')], { default_revenue: '4200' });
      expect({ imported: out.imported, headerRefusals: out.errors.filter((e) => /header|without exactly one/.test(e)),
        holders: await holders('default_revenue'), resolves: await resolve('default_revenue') })
        .toEqual({ imported: 1, headerRefusals: [], holders: ['4200'], resolves: '4200' });
    });

    it('maps cost of sales onto a code the SAME import makes a header: both rows imported, the child under it, the role on it', async () => {
      const out = await importing([row('5300', 'expense'), row('5301', 'expense', { parentCode: '5300', accountSubtype: 'operating_expense' })],
        { default_expense: '5300' });
      expect({ imported: out.imported, headerRefusals: out.errors.filter((e) => /header|without exactly one|cannot go under/.test(e)),
        parent: await parentOf('5301'), holders: await holders('default_expense'), resolves: await resolve('default_expense') })
        .toEqual({ imported: 2, headerRefusals: [], parent: '5300', holders: ['5300'], resolves: '5300' });
    });

    it('still refuses the bank role on an existing header and the payable role on a header the import makes; nothing written', async () => {
      const before = await fx.hash();
      const bank = await importing([row('1200', 'asset')], { bank: '1200' });
      const payable = await importing([row('2300', 'liability'), row('2301', 'liability', { parentCode: '2300' })], { payable: '2300' });
      expect({ bank, payable: { imported: payable.imported, header: payable.errors.filter((e) => /is a header/.test(e)) } }).toEqual({
        bank: { status: 200, imported: 0, errors: [expect.stringMatching(/^Account 1200 is a header with sub-accounts, so it cannot hold the 'bank' role \(a balance-sheet role cannot be held by a header\)\./)] },
        payable: { imported: 0, header: [expect.stringMatching(/^Account 2300 is a header with sub-accounts, so it cannot hold the 'payable' role/)] },
      });
      expect({ unchanged: (await fx.hash()) === before, bank: await holders('bank'), payable: await holders('payable') })
        .toEqual({ unchanged: true, bank: ['1110'], payable: ['2110'] });
    });
  });

  describe('the post-condition (systemRoleInvariant)', () => {
    it('accepts an income-statement holder that is a header', async () => {
      const before = await snapshotRoles(CO);
      await moveFlag('default_revenue', RH);
      await expect(assertRolesKept(CO, before, new Map([['default_revenue', RH]]))).resolves.toBeUndefined();
    });

    it('rejects a balance-sheet holder that is a header', async () => {
      const before = await snapshotRoles(CO);
      await moveFlag('bank', AH);
      await expect(assertRolesKept(CO, before, new Map([['bank', AH]]))).rejects.toBeInstanceOf(SystemRoleInvariantError);
    });
  });

  describe('reactivating a former holder into an empty role', () => {
    it('an income-statement header is reactivated and holds the role; a balance-sheet header is refused and the role stays empty', async () => {
      await fx.query('DELETE FROM gl_accounts WHERE id = ANY($1::uuid[])', [[EXP, BANK]]);
      await fx.query("UPDATE gl_accounts SET is_system_account = true, account_subtype = 'default_expense', is_active = false WHERE id = $1", [EH]);
      await fx.query("UPDATE gl_accounts SET is_system_account = true, account_subtype = 'bank', is_active = false WHERE id = $1", [AH]);
      const expense = await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: EH, isActive: true });
      const bank = await fx.call(coa, 'PUT', '/api/accounting/chart-of-accounts', { id: AH, isActive: true });
      expect({ expense: expense.statusCode, bank: bank.statusCode, bankText: message(bank),
        expenseHolders: await holders('default_expense'), bankHolders: await holders('bank') }).toEqual({
        expense: 200, bank: 400, bankText: expect.stringMatching(/^Account 1200 has sub-accounts, and an account that holds a balance-sheet role such as bank cannot be a header\./),
        expenseHolders: ['5200'], bankHolders: [] });
    });
  });
});
