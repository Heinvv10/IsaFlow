/**
 * The two chart edits that could turn a POSTED account into a header the balance sheet drops
 * (gl/headerAccountGuard guards new lines; these guard the lines already there), PR #701 breaker REPRO 1 and 2:
 *  - PUT /api/accounting/bank-accounts {id, parentAccountId}: grouping under a posted level 1-2 account is a 400;
 *  - reclassifyAccount: a move UP that takes an account in the moved subtree from level 3 to below it, while it has
 *    sub-accounts and journal lines, is refused. A move down, and an account already below level 3, never are.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { reclassifyAccount } from '@/modules/accounting/services/gl/accountReclassifyService';
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
    entryDate: DATE, description: 'HGC', source: 'manual',
    lines: [{ glAccountId: account, debit: 100, credit: 0 }, { glAccountId: h.fx.bankAccountId, debit: 0, credit: 100 }],
  }, h.fx.userId);
  await postJournalEntry(h.fx.companyId, e.id, h.fx.userId);
});

const shape = async (ids: string[]) => ((await sql`
  SELECT id::TEXT AS id, level, parent_account_id::TEXT AS parent FROM gl_accounts
   WHERE id = ANY(${ids}::UUID[]) ORDER BY id`) as Row[]);

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

describeIfDb('a posted account cannot become a hidden header through a chart edit', () => {
  beforeAll(async () => { h = await seedHeaderFixture('HGC', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropHeaderFixture(h); }, 120000);

  describe('R1: PUT bank-accounts parentAccountId', () => {
    const bank = (code: string, level = 1) => addAccount(h.fx, { code, type: 'asset', level, subtype: 'bank' });
    const parentOf = async (id: string) => String(((await sql`
      SELECT COALESCE(parent_account_id::TEXT, '') AS p FROM gl_accounts WHERE id = ${id}::UUID`) as Row[])[0]!.p);

    it('a posted level-1 bank account as the group is a 400 with the message; nothing changes', async () => {
      const group = await bank('HGC-B1');
      const member = await bank('HGC-B2');
      await post(group);
      const before = await shape([group, member]);
      const out = await putBankAccount({ id: member, parentAccountId: group });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
      expect(JSON.stringify(out.body)).toContain('HGC-B1 has journal lines posted to it');
      expect(await shape([group, member])).toEqual(before);
      expect(await parentOf(member)).toBe('');
    });

    it('control: a group with no postings is accepted', async () => {
      const group = await bank('HGC-B3');
      const member = await bank('HGC-B4');
      const out = await putBankAccount({ id: member, parentAccountId: group });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
      expect(await parentOf(member)).toBe(group);
    });

    it('control: a posted level-3 group stays on the balance sheet, so it is accepted', async () => {
      const group = await bank('HGC-B5', 3);
      const member = await bank('HGC-B6');
      await post(group);
      const out = await putBankAccount({ id: member, parentAccountId: group });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
      expect(await parentOf(member)).toBe(group);
    });
  });

  describe('R2: reclassifyAccount moving an account UP', () => {
    /** T1 (1) > T2 (2) > T3 (3, a child T4) — T3 posted unless told otherwise. */
    const tree = async (tag: string, posted: boolean) => {
      const t1 = await addAccount(h.fx, { code: `HGC-${tag}1`, type: 'asset', level: 1 });
      const t2 = await addAccount(h.fx, { code: `HGC-${tag}2`, type: 'asset', level: 2, parentId: t1 });
      const t3 = await addAccount(h.fx, { code: `HGC-${tag}3`, type: 'asset', level: 3, parentId: t2 });
      const t4 = await addAccount(h.fx, { code: `HGC-${tag}4`, type: 'asset', level: 4, parentId: t3 });
      if (posted) await post(t3);
      return { t1, t2, t3, t4, all: [t1, t2, t3, t4] };
    };
    const move = (id: string, parentAccountId: string | null) =>
      inTx(h.fx, () => reclassifyAccount(h.fx.companyId, id, { parentAccountId })).then(() => null, (e: unknown) => e as Error);

    it('promoting T2 to the top is refused while T3 (posted, with a child) would drop to level 2; nothing changes', async () => {
      const t = await tree('P', true);
      const before = await shape(t.all);
      const err = await move(t.t2, null);
      expect(err?.message, 'the move was not refused').toContain('would put HGC-P3 above level 3');
      expect(await shape(t.all)).toEqual(before);
    });

    it('control: the same move succeeds when T3 has no lines, and the subtree shifts', async () => {
      const t = await tree('U', false);
      expect(await move(t.t2, null)).toBeNull();
      const levels = new Map((await shape(t.all)).map((r) => [String(r.id), Number(r.level)]));
      expect([t.t1, t.t2, t.t3, t.t4].map((id) => levels.get(id))).toEqual([1, 1, 2, 3]);
    });

    it('moving the posted level-3 parent itself to the top is refused; nothing changes', async () => {
      const t = await tree('S', true);
      const before = await shape(t.all);
      const err = await move(t.t3, null);
      expect(err?.message, 'the move was not refused').toContain('would put HGC-S3 above level 3');
      expect(await shape(t.all)).toEqual(before);
    });

    it('a move DOWN is never refused: the posted T3 under a level-3 account becomes level 4', async () => {
      const t = await tree('D', true);
      const deeper = await addAccount(h.fx, { code: 'HGC-D9', type: 'asset', level: 3 });
      expect(await move(t.t3, deeper)).toBeNull();
      const levels = new Map((await shape(t.all)).map((r) => [String(r.id), Number(r.level)]));
      expect([levels.get(t.t3), levels.get(t.t4)]).toEqual([4, 5]);
    });

    it('a posted level-3 account with NO child is not a header after the move: promoting it is allowed', async () => {
      const t = await tree('K', false);
      const leaf = await addAccount(h.fx, { code: 'HGC-K9', type: 'asset', level: 3, parentId: t.t2 });
      await post(leaf);
      expect(await move(leaf, null)).toBeNull();
    });

    it('only asset, liability and equity are judged: a posted expense level-3 parent with a child may be promoted', async () => {
      const t1 = await addAccount(h.fx, { code: 'HGC-X1', type: 'expense', level: 1 });
      const t2 = await addAccount(h.fx, { code: 'HGC-X2', type: 'expense', level: 2, parentId: t1 });
      const t3 = await addAccount(h.fx, { code: 'HGC-X3', type: 'expense', level: 3, parentId: t2 });
      await addAccount(h.fx, { code: 'HGC-X4', type: 'expense', level: 4, parentId: t3 });
      await post(t3);
      expect(await move(t2, null)).toBeNull();
    });

    it('an account already below level 3 does not block: a legacy posted level-2 parent moves to the top', async () => {
      const root = await addAccount(h.fx, { code: 'HGC-L1', type: 'asset', level: 1 });
      const legacy = await addAccount(h.fx, { code: 'HGC-L2', type: 'asset', level: 2, parentId: root });
      await addAccount(h.fx, { code: 'HGC-L3', type: 'asset', level: 3, parentId: legacy });
      await sql`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
        SELECT ${h.fx.companyId}::UUID, ${`HGC-LEG-${h.fx.tag}`.slice(0, 40)}, ${DATE}::DATE, 'legacy', 'manual', 'draft', ${h.fx.userId}`;
      const je = String(((await sql`
        SELECT id FROM gl_journal_entries WHERE company_id = ${h.fx.companyId}::UUID AND description = 'legacy'`) as Row[])[0]!.id);
      await sql`INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id) VALUES
        (${je}::UUID, ${legacy}::UUID, 100, 0, ${h.fx.companyId}::UUID), (${je}::UUID, ${h.fx.bankAccountId}::UUID, 0, 100, ${h.fx.companyId}::UUID)`;
      expect(await move(legacy, null)).toBeNull();
    });
  });
});
