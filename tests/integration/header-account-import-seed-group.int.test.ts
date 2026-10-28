/**
 * Three more writers of `parent_account_id` that could turn a posted level 1-2 account into a header the balance
 * sheet drops, found by the ledger review of PR #878 (2026-10-26):
 *  - the chart import (migrationCoaService) gave a NEW account any existing parent without assertParentUsable,
 *    and always at level 2;
 *  - the template seed (POST /api/accounting/coa-seed) re-pointed EXISTING accounts at template parents and
 *    gave children to any template-coded account, posted or not;
 *  - the bank grouping PUT set the parent but never the member's level.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { importChartOfAccounts, type AccountImportRow } from '@/modules/accounting/services/core/migrationCoaService';
import { createSession } from '@/modules/accounting/services/core/migrationService';
import { seedChartOfAccountsFromTemplate } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { addAccount, dropHeaderFixture, seedHeaderFixture, type HeaderFixture } from './helpers/headerGuardFixture';
import bankAccounts from '../../pages/api/accounting/bank-accounts';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
const DATE = '2026-07-10';
let h: HeaderFixture;

const post = (account: string) => inTx(h.fx, async () => {
  const e = await createJournalEntry(h.fx.companyId, {
    entryDate: DATE, description: 'HIS', source: 'manual',
    lines: [{ glAccountId: account, debit: 100, credit: 0 }, { glAccountId: h.fx.bankAccountId, debit: 0, credit: 100 }],
  }, h.fx.userId);
  await postJournalEntry(h.fx.companyId, e.id, h.fx.userId);
});

const byCode = async (code: string) => ((await sql`
  SELECT id::TEXT AS id, level, COALESCE(parent_account_id::TEXT, '') AS parent FROM gl_accounts
   WHERE company_id = ${h.fx.companyId}::UUID AND account_code = ${code}`) as Row[])[0];
const byId = async (id: string) => ((await sql`
  SELECT level, COALESCE(parent_account_id::TEXT, '') AS parent FROM gl_accounts WHERE id = ${id}::UUID`) as Row[])[0]!;
const childCount = async (id: string) => Number(((await sql`
  SELECT COUNT(*)::INT AS n FROM gl_accounts WHERE parent_account_id = ${id}::UUID`) as Row[])[0]!.n);

const importRows = (rows: AccountImportRow[]) => inTx(h.fx, async () => {
  const session = await createSession(h.fx.companyId, 'sage', h.fx.userId);
  return importChartOfAccounts(h.fx.companyId, session.id, rows, {} as never);
});
const row = (accountCode: string, parentCode?: string): AccountImportRow =>
  ({ accountCode, accountName: `Imported ${accountCode}`, accountType: 'asset', normalBalance: 'debit',
    accountSubtype: 'other_current_asset', ...(parentCode ? { parentCode } : {}) });

async function putBankAccount(body: Record<string, unknown>) {
  const token = await new SignJWT({ sub: h.fx.userId, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const req = request({ 'sb-access-token': token, active_company_id: h.fx.companyId }, 'PUT') as never as
    { body: unknown; query: unknown; url: string };
  req.body = body;
  req.query = {};
  req.url = '/api/accounting/bank-accounts';
  const out = response();
  await (bankAccounts as never as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return out.state;
}

describeIfDb('the import, the template seed and the bank grouping keep posted accounts on the balance sheet', () => {
  beforeAll(async () => { h = await seedHeaderFixture('HIS', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM migration_sessions WHERE company_id = ${h.fx.companyId}::UUID`;   // the import tests' sessions
    await dropHeaderFixture(h);
  }, 120000);

  describe('chart import', () => {
    it('a new account under a posted, childless level-1 account is refused and not written', async () => {
      const p = await addAccount(h.fx, { code: 'HIS-P1', type: 'asset', level: 1 });
      await post(p);
      const out = await importRows([row('HIS-C1', 'HIS-P1')]);
      expect(out.imported).toBe(0);
      expect(out.errors.map((e) => e.message).join(' ')).toContain('HIS-P1 is a level-1 asset account with journal lines');
      expect(out.errors[0]!.field).toBe('parentCode');
      expect(await byCode('HIS-C1')).toBeUndefined();
      expect(await childCount(p)).toBe(0);
    });

    it('a new account takes its parent\'s level + 1 (a level-2 parent gives level 3)', async () => {
      const top = await addAccount(h.fx, { code: 'HIS-T1', type: 'asset', level: 1 });
      await addAccount(h.fx, { code: 'HIS-T2', type: 'asset', level: 2, parentId: top });
      const out = await importRows([row('HIS-T3', 'HIS-T2')]);
      expect(out.errors).toEqual([]);
      expect(Number((await byCode('HIS-T3'))!.level)).toBe(3);
    });

    it('a parent created earlier in the same file is accepted', async () => {
      const out = await importRows([row('HIS-N1'), row('HIS-N2', 'HIS-N1')]);
      expect(out.errors).toEqual([]);
      expect((await byCode('HIS-N2'))!.parent).toBe((await byCode('HIS-N1'))!.id);
    });

    it('a posted parent that already has a child takes another (already a header)', async () => {
      const p = await addAccount(h.fx, { code: 'HIS-H1', type: 'asset', level: 1 });
      await post(p);
      await addAccount(h.fx, { code: 'HIS-H1.1', type: 'asset', level: 2, parentId: p });
      const out = await importRows([row('HIS-H2', 'HIS-H1')]);
      expect(out.errors).toEqual([]);
      expect((await byCode('HIS-H2'))!.parent).toBe(p);
    });

    it('a new account under the bank role holder is refused and not written', async () => {
      const bankCode = String(((await sql`SELECT account_code FROM gl_accounts WHERE id = ${h.fx.bankAccountId}::UUID`) as Row[])[0]!.account_code);
      const out = await importRows([row('HIS-UB', bankCode)]);
      expect(out.imported).toBe(0);
      expect(out.errors[0]).toMatchObject({ field: 'parentCode', message: expect.stringContaining('holds the bank role') });
      expect(await byCode('HIS-UB')).toBeUndefined();
    });

    it('a parent row held by another request fails the whole import as retryable, not as a row error', async () => {
      const p = await addAccount(h.fx, { code: 'HIS-L1', type: 'asset', level: 1 });
      const holder = await h.fx.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR UPDATE', [p]);
        const err = await importRows([row('HIS-L2', 'HIS-L1')]).then(() => null, (e: unknown) => e as Error);
        expect(err?.name, String(err)).toBe('GlAccountLockTimeoutError');
      } finally { await holder.query('ROLLBACK'); holder.release(); }
      expect(await byCode('HIS-L2')).toBeUndefined();
    }, 30000);

    it('a row that would re-type an account with lines and sub-accounts keeps its type, with a warning', async () => {
      const x = await addAccount(h.fx, { code: 'HIS-X1', type: 'expense', level: 1, subtype: 'operating_expense' });
      await post(x);
      await addAccount(h.fx, { code: 'HIS-X1.1', type: 'expense', level: 2, parentId: x, subtype: 'operating_expense' });
      const out = await importRows([row('HIS-X1')]);
      const after = ((await sql`SELECT account_type, account_subtype, normal_balance, account_name FROM gl_accounts
        WHERE id = ${x}::UUID`) as Row[])[0]!;
      expect(after).toMatchObject({ account_type: 'expense', account_subtype: 'operating_expense', normal_balance: 'debit',
        account_name: 'Imported HIS-X1' });
      expect(out.errors[0]).toMatchObject({ severity: 'warning', message: expect.stringContaining('has sub-accounts') });
    });

    it('control: re-typing an account in use that would not hide anything is a reclassification and goes through', async () => {
      const r = await addAccount(h.fx, { code: 'HIS-X3', type: 'expense', level: 1, subtype: 'operating_expense' });
      await post(r);
      const out = await importRows([row('HIS-X3')]);
      expect(out.errors).toEqual([]);
      expect(((await sql`SELECT account_type FROM gl_accounts WHERE id = ${r}::UUID`) as Row[])[0]!.account_type).toBe('asset');
    });

    it('an unused parent is not re-typed either: a journal posting to it later must not land on a hidden header', async () => {
      const q = await addAccount(h.fx, { code: 'HIS-Q1', type: 'expense', level: 1, subtype: 'operating_expense' });
      await addAccount(h.fx, { code: 'HIS-Q1.1', type: 'expense', level: 2, parentId: q, subtype: 'operating_expense' });
      const out = await importRows([row('HIS-Q1')]);
      expect(((await sql`SELECT account_type FROM gl_accounts WHERE id = ${q}::UUID`) as Row[])[0]!.account_type).toBe('expense');
      expect(out.errors[0]).toMatchObject({ severity: 'warning', message: expect.stringContaining('has sub-accounts') });
    });

    it('a parent at a NULL level keeps its type too', async () => {
      const x = await addAccount(h.fx, { code: 'HIS-NL1', type: 'expense', level: 1, subtype: 'operating_expense' });
      await post(x);
      await addAccount(h.fx, { code: 'HIS-NL1.1', type: 'expense', level: 2, parentId: x, subtype: 'operating_expense' });
      await sql`UPDATE gl_accounts SET level = NULL WHERE id = ${x}::UUID`;
      const out = await importRows([row('HIS-NL1')]);
      expect(((await sql`SELECT account_type FROM gl_accounts WHERE id = ${x}::UUID`) as Row[])[0]!.account_type).toBe('expense');
      expect(out.errors[0]).toMatchObject({ severity: 'warning' });
    });

    it('an import waits for a posting in flight to an account it names, then sees its line', async () => {
      const x = await addAccount(h.fx, { code: 'HIS-R1', type: 'expense', level: 1, subtype: 'operating_expense' });
      await addAccount(h.fx, { code: 'HIS-R1.1', type: 'expense', level: 2, parentId: x, subtype: 'operating_expense' });
      const a = await h.fx.pool.connect();
      try {
        await a.query('BEGIN');
        // The header's first line (an expense header may be posted to), not yet committed.
        await runOn(h.fx, a, async () => {
          const e = await createJournalEntry(h.fx.companyId, { entryDate: DATE, description: 'HIS race', source: 'manual',
            lines: [{ glAccountId: x, debit: 100, credit: 0 }, { glAccountId: h.fx.bankAccountId, debit: 0, credit: 100 }] }, h.fx.userId);
          await postJournalEntry(h.fx.companyId, e.id, h.fx.userId);
        });
        const state = { settled: false };
        const imported = importRows([row('HIS-R1')]).finally(() => { state.settled = true; });
        await new Promise((r) => setTimeout(r, 1500));
        expect(state.settled, 'the import did not wait for the posting').toBe(false);
        await a.query('COMMIT');
        const out = await imported;
        expect(((await sql`SELECT account_type FROM gl_accounts WHERE id = ${x}::UUID`) as Row[])[0]!.account_type).toBe('expense');
        expect(out.errors[0]).toMatchObject({ severity: 'warning' });
      } finally { await a.query('ROLLBACK').catch(() => undefined); a.release(); }
    }, 30000);

    it('control: an unused account is re-typed by the import as before', async () => {
      const u = await addAccount(h.fx, { code: 'HIS-X2', type: 'expense', level: 1, subtype: 'operating_expense' });
      const out = await importRows([row('HIS-X2')]);
      expect(out.errors).toEqual([]);
      expect(((await sql`SELECT account_type FROM gl_accounts WHERE id = ${u}::UUID`) as Row[])[0]!.account_type).toBe('asset');
    });

    it('re-importing an EXISTING account with a parent code changes no parent and is not refused', async () => {
      const p = await addAccount(h.fx, { code: 'HIS-E1', type: 'asset', level: 1 });
      await post(p);
      const existing = await addAccount(h.fx, { code: 'HIS-E2', type: 'asset', level: 1 });
      const out = await importRows([row('HIS-E2', 'HIS-E1')]);
      expect(out.errors).toEqual([]);
      expect((await byId(existing)).parent).toBe('');
      expect(await childCount(p)).toBe(0);
    });
  });

  describe('template seed', () => {
    it('never re-points an existing account and never gives a posted, childless account its first child', async () => {
      // 1200 "Non-Current Assets" and 1130 "Petty Cash" are template codes; the company already has both.
      const posted1200 = await addAccount(h.fx, { code: '1200', type: 'asset', level: 2 });
      await post(posted1200);
      const myHeader = await addAccount(h.fx, { code: 'HIS-MINE', type: 'asset', level: 1 });
      const mine1130 = await addAccount(h.fx, { code: '1130', type: 'asset', level: 2, parentId: myHeader });
      // The company's own 5000 is a REVENUE account; the template's 5000 children are expenses.
      const rev5000 = await addAccount(h.fx, { code: '5000', type: 'revenue', level: 1, subtype: 'revenue' });
      // 2200 "Non-Current Liabilities" already exists here at level 3 with no lines: it takes its template children.
      const mine2200 = await addAccount(h.fx, { code: '2200', type: 'liability', level: 3 });
      await inTx(h.fx, () => seedChartOfAccountsFromTemplate(h.fx.companyId, 'isaflow_standard'));
      // 1210 "Equipment" is inserted, but not under the posted 1200, and so at level 1.
      expect(await byCode('1210')).toMatchObject({ parent: '', level: 1 });
      expect(await childCount(posted1200)).toBe(0);
      // No template expense goes under the company's revenue 5000.
      expect(await childCount(rev5000)).toBe(0);
      // The company's own 1130 keeps its parent.
      expect((await byId(mine1130)).parent).toBe(myHeader);
      // An existing parent with no lines gets its children, one level below it (4, not the template's 3).
      const kids = (await sql`SELECT level FROM gl_accounts WHERE parent_account_id = ${mine2200}::UUID`) as Row[];
      expect(kids.length).toBeGreaterThan(0);
      expect(kids.every((k) => Number(k.level) === 4)).toBe(true);
      // Every account in the company with a parent sits exactly one level below it.
      const off = (await sql`
        SELECT c.account_code FROM gl_accounts c JOIN gl_accounts p ON p.id = c.parent_account_id
         WHERE c.company_id = ${h.fx.companyId}::UUID AND c.level <> p.level + 1
           AND c.account_code !~ '^HIS-'`) as Row[];
      expect(off.map((r) => r.account_code)).toEqual([]);
    });
  });

  describe('bank grouping PUT', () => {
    const bank = (code: string, level = 1) => addAccount(h.fx, { code, type: 'asset', level, subtype: 'bank' });

    it('grouping puts the member one level below the group; ungrouping returns it to level 1', async () => {
      const group = await bank('HIS-G1');
      const member = await bank('HIS-G1M');
      const put1 = await putBankAccount({ id: member, parentAccountId: group });
      expect(put1.statusCode, JSON.stringify(put1.body)).toBe(200);
      expect(await byId(member)).toEqual({ level: 2, parent: group });
      const put2 = await putBankAccount({ id: member, parentAccountId: null });
      expect(put2.statusCode, JSON.stringify(put2.body)).toBe(200);
      expect(await byId(member)).toEqual({ level: 1, parent: '' });
    });

    it('a save that does not change the group moves nothing (same group, or "no group" under a chart header)', async () => {
      const group = await bank('HIS-G3');
      const member = await bank('HIS-G3M');
      await putBankAccount({ id: member, parentAccountId: group });
      await sql`UPDATE gl_accounts SET level = 3 WHERE id = ${member}::UUID`;   // a level the move would reset
      const same = await putBankAccount({ id: member, bankAccountNumber: '111', parentAccountId: group });
      expect(same.statusCode, JSON.stringify(same.body)).toBe(200);
      expect(await byId(member)).toEqual({ level: 3, parent: group });
      const header = await addAccount(h.fx, { code: 'HIS-HDR', type: 'asset', level: 1 });
      const underHeader = await addAccount(h.fx, { code: 'HIS-HDR.1', type: 'asset', level: 2, subtype: 'bank', parentId: header });
      const none = await putBankAccount({ id: underHeader, bankAccountNumber: '222', parentAccountId: null });
      expect(none.statusCode, JSON.stringify(none.body)).toBe(200);
      expect(await byId(underHeader)).toEqual({ level: 2, parent: header });
    });

    it('ungrouping is refused when it would lift a posted account with sub-accounts above level 3', async () => {
      const top = await addAccount(h.fx, { code: 'HIS-U0', type: 'asset', level: 1 });
      const group = await addAccount(h.fx, { code: 'HIS-U1', type: 'asset', level: 2, subtype: 'bank', parentId: top });
      const member = await addAccount(h.fx, { code: 'HIS-U2', type: 'asset', level: 3, subtype: 'bank', parentId: group });
      await post(member);
      await addAccount(h.fx, { code: 'HIS-U3', type: 'asset', level: 4, parentId: member });
      const out = await putBankAccount({ id: member, parentAccountId: null });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
      expect(JSON.stringify(out.body)).toContain('would put HIS-U2 above level 3');
      expect(await byId(member)).toEqual({ level: 3, parent: group });
    });

    it('the grouping route will not move an account that is not a bank account', async () => {
      const group = await bank('HIS-G2');
      const notBank = await addAccount(h.fx, { code: 'HIS-NB', type: 'asset', level: 1 });
      const out = await putBankAccount({ id: notBank, parentAccountId: group });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
      expect(await byId(notBank)).toEqual({ level: 1, parent: '' });
    });
  });
});
