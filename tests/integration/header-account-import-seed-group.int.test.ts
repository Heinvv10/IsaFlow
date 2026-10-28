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
import { ensureOpeningBalanceEquityAccount } from '@/modules/accounting/services/gl/openingBalanceEquityService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
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
      // NULL levels count as top level: a posted, childless NULL-level 3000 (equity) gets no child, and an
      // unposted NULL-level 4000 (revenue) gets its template children at level 1 (NULL + 1, as assertParentUsable).
      const nul3000 = await addAccount(h.fx, { code: '3000', type: 'equity', level: 1 });
      await post(nul3000);
      const nul4000 = await addAccount(h.fx, { code: '4000', type: 'revenue', level: 1, subtype: 'revenue' });
      await sql`UPDATE gl_accounts SET level = NULL WHERE id = ANY(${[nul3000, nul4000]}::UUID[])`;
      // The company's own 5000 is a REVENUE account; the template's 5000 children are expenses.
      const rev5000 = await addAccount(h.fx, { code: '5000', type: 'revenue', level: 1, subtype: 'revenue' });
      // 2200 "Non-Current Liabilities" already exists here at level 3 with no lines: it takes its template children.
      const mine2200 = await addAccount(h.fx, { code: '2200', type: 'liability', level: 3 });
      await inTx(h.fx, () => seedChartOfAccountsFromTemplate(h.fx.companyId, 'isaflow_standard'));
      // 1210 "Equipment" is inserted, but not under the posted 1200, and so at level 1.
      expect(await byCode('1210')).toMatchObject({ parent: '', level: 1 });
      expect(await childCount(posted1200)).toBe(0);
      expect(await childCount(nul3000)).toBe(0);
      const rev4000Kids = (await sql`SELECT level FROM gl_accounts WHERE parent_account_id = ${nul4000}::UUID`) as Row[];
      expect(rev4000Kids.length).toBeGreaterThan(0);
      expect(rev4000Kids.every((k) => Number(k.level) === 1)).toBe(true);
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
         WHERE c.company_id = ${h.fx.companyId}::UUID AND c.level <> COALESCE(p.level, 0) + 1
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

  describe('Opening Balance Equity, created on first use under 3000', () => {
    let o: HeaderFixture;
    beforeAll(async () => { o = await seedHeaderFixture('HISO', process.env.DATABASE_URL!); }, 120000);
    afterAll(async () => { await dropHeaderFixture(o); }, 120000);
    const obeParent = async () => String(((await sql`
      SELECT COALESCE(parent_account_id::TEXT, '') AS p FROM gl_accounts
       WHERE company_id = ${o.fx.companyId}::UUID AND account_subtype = 'opening_balance_equity'`) as Row[])[0]!.p);

    it('is not put under a posted, childless level-1 3000: it goes to the top level', async () => {
      const e3000 = await addAccount(o.fx, { code: '3000', type: 'equity', level: 1 });
      await inTx(o.fx, async () => {
        const e = await createJournalEntry(o.fx.companyId, { entryDate: DATE, description: 'HISO', source: 'manual',
          lines: [{ glAccountId: o.fx.bankAccountId, debit: 100, credit: 0 }, { glAccountId: e3000, debit: 0, credit: 100 }] }, o.fx.userId);
        await postJournalEntry(o.fx.companyId, e.id, o.fx.userId);
      });
      await inTx(o.fx, () => ensureOpeningBalanceEquityAccount(o.fx.companyId));
      expect(await childCount(e3000)).toBe(0);
      expect(await obeParent()).toBe('');
    });
  });
});
