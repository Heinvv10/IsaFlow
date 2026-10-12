/**
 * No NEW journal line lands on a balance-sheet header (gl/headerAccountGuard), at the funnel every
 * poster shares: an asset / liability / equity account below level 3 that has sub-accounts.
 *
 *  - createJournalEntry refuses one (and writes nothing); a childless leaf, a revenue or expense
 *    header and a level-3 account with children are all let through;
 *  - the exemption is PER ACCOUNT: a reversal, and a reclassification's source leg, mirror lines
 *    already posted, but every other leg of the same journal is still judged;
 *  - POST /api/accounting/journal-entries answers 400 with the message;
 *  - the guard's FOR KEY SHARE on the subject account excludes a chart edit's FOR UPDATE.
 * The other writers (recurring, bank, depreciation, year end): header-account-guard-writers.int.test.ts.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { postReclassBatch } from '@/modules/accounting/services/gl/reclassification/post';
import { assertNoHeaderAccountLines, HeaderAccountRefusal } from '@/modules/accounting/services/gl/headerAccountGuard';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, runOn } from './helpers/l1FifoFixture';
import { countRows } from './helpers/vatLateClaimFixture';
import { callRoute, dataOf } from './helpers/vatLateClaimRoutes';
import {
  addAccount, dropHeaderFixture, seedHeaderFixture, type HeaderAccount, type HeaderFixture,
} from './helpers/headerGuardFixture';
import journalEntries from '../../pages/api/accounting/journal-entries';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
type Lines = { glAccountId: string; debit: number; credit: number }[];
const DATE = '2026-07-10';
const HEADER_TEXT = 'is a header with sub-accounts; post to one of them.';
let h: HeaderFixture;

const create = (lines: Lines, contraAccountIds?: string[]) => inTx(h.fx, () => createJournalEntry(h.fx.companyId, {
  entryDate: DATE, description: 'HG', source: 'manual', lines,
}, h.fx.userId, undefined, contraAccountIds ? { contraAccountIds } : undefined));

/** R100 on `account` (debit, or credit when `side` says so) against the leaf bank account. */
const pair = (account: string, side: 'debit' | 'credit' = 'debit'): Lines => [
  { glAccountId: account, debit: side === 'debit' ? 100 : 0, credit: side === 'credit' ? 100 : 0 },
  { glAccountId: h.fx.bankAccountId, debit: side === 'credit' ? 100 : 0, credit: side === 'debit' ? 100 : 0 },
];

const refusalOf = async (run: Promise<unknown>): Promise<HeaderAccountRefusal> => {
  const err = await run.then(() => null, (e: unknown) => e);
  expect(err, 'the journal was not refused').toBeInstanceOf(HeaderAccountRefusal);
  return err as HeaderAccountRefusal;
};

const entriesWhere = async (reversalOf: string) => (await sql`
  SELECT id FROM gl_journal_entries WHERE company_id = ${h.fx.companyId}::UUID AND reversal_of_id = ${reversalOf}::UUID`) as Row[];

describeIfDb('createJournalEntry refuses a line on a balance-sheet header', () => {
  beforeAll(async () => { h = await seedHeaderFixture('HGD', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropHeaderFixture(h); }, 120000);

  it.each(['assetHdr', 'liabHdr', 'equityHdr'] as const)('refuses %s, names it, and writes nothing', async (key) => {
    const account: HeaderAccount = h[key];
    const before = await countRows(h.fx);
    const err = await refusalOf(create(pair(account.id)));
    expect(err.lineIndex).toBe(0);
    expect(err.code).toBe('HEADER_ACCOUNT_REFUSED');
    expect(err.message).toContain(`Line 1: ${account.code} ${account.code} name ${h.fx.tag} ${HEADER_TEXT}`);
    expect(await countRows(h.fx)).toEqual(before);
  });

  it('compares ids case-blind: an upper-case header id is refused, an upper-case contra exemption holds', async () => {
    const upper = h.assetHdr.id.toUpperCase();
    const err = await refusalOf(create(pair(upper)));
    expect(err.lineIndex).toBe(0);
    expect(err.message).toContain(`Line 1: ${h.assetHdr.code} `);
    await expect(create(pair(h.assetHdr.id), [upper])).resolves.toBeTruthy();
  });

  it('names the line the header is on', async () => {
    const lines: Lines = [
      { glAccountId: h.fx.bankAccountId, debit: 100, credit: 0 },
      { glAccountId: h.liabHdr.id, debit: 0, credit: 100 },
    ];
    const err = await refusalOf(create(lines));
    expect(err.lineIndex).toBe(1);
    expect(err.message).toContain(`Line 2: ${h.liabHdr.code} `);
  });

  it.each([
    ['a childless level-1 leaf', (): string => h.leaf, 'debit'],
    ['an expense header with a child', (): string => h.expenseHdr.id, 'debit'],
    ['a revenue header (level 2) with a child', (): string => h.revenueHdr.id, 'credit'],
    ['a level-3 asset with a child', (): string => h.assetL3.id, 'debit'],
    ['the CHILD of a header', (): string => h.assetHdr.childId, 'debit'],
  ] as const)('lets %s through', async (_name, account, side) => {
    const entry = await create(pair(account(), side));
    expect(entry.id).toEqual(expect.any(String));
    expect(((await sql`SELECT 1 FROM gl_journal_lines WHERE journal_entry_id = ${entry.id}::UUID`) as Row[])).toHaveLength(2);
  });

  it('a contra exemption is per account: the other header in the same journal is still refused', async () => {
    const lines: Lines = [
      { glAccountId: h.assetHdr.id, debit: 100, credit: 0 },
      { glAccountId: h.liabHdr.id, debit: 0, credit: 100 },
    ];
    const err = await refusalOf(create(lines, [h.assetHdr.id]));
    expect(err.lineIndex).toBe(1);
    expect(err.message).toContain(`Line 2: ${h.liabHdr.code} `);
    // ... and naming both is the only way through.
    expect((await create(lines, [h.assetHdr.id, h.liabHdr.id])).id).toEqual(expect.any(String));
  });

  it('a reversal of a journal whose line now sits on a header posts its contra; a fresh journal there is refused', async () => {
    const acct = await addAccount(h.fx, { code: 'HG-REV', type: 'asset', level: 1 });
    const original = await inTx(h.fx, async () => {
      const je = await createJournalEntry(h.fx.companyId, {
        entryDate: DATE, description: 'HG original', source: 'manual', lines: pair(acct),
      }, h.fx.userId);
      await postJournalEntry(h.fx.companyId, je.id, h.fx.userId);
      return je;
    });
    await addAccount(h.fx, { code: 'HG-REV.1', type: 'asset', level: 2, parentId: acct });
    await refusalOf(create(pair(acct)));

    await inTx(h.fx, () => reverseJournalEntry(h.fx.companyId, original.id, h.fx.userId));
    const [contra] = await entriesWhere(original.id);
    expect(contra, 'no contra entry').toBeDefined();
    const legs = (await sql`
      SELECT debit::FLOAT8 AS debit, credit::FLOAT8 AS credit FROM gl_journal_lines
       WHERE journal_entry_id = ${String(contra!.id)}::UUID AND gl_account_id = ${acct}::UUID`) as Row[];
    expect(legs).toEqual([{ debit: 0, credit: 100 }]);
  });

  it('a reclassification may move lines OFF a header (its source leg) but not ONTO another one', async () => {
    const source = await addAccount(h.fx, { code: 'HG-SRC', type: 'asset', level: 1 });
    const target = await addAccount(h.fx, { code: 'HG-TGT', type: 'asset', level: 1 });
    const originalLine = await inTx(h.fx, async () => {
      const je = await createJournalEntry(h.fx.companyId, {
        entryDate: DATE, description: 'HG to reclassify', source: 'manual', lines: pair(source),
      }, h.fx.userId);
      await postJournalEntry(h.fx.companyId, je.id, h.fx.userId);
      return String(((await sql`
        SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${je.id}::UUID AND gl_account_id = ${source}::UUID`) as Row[])[0]!.id);
    });
    await addAccount(h.fx, { code: 'HG-SRC.1', type: 'asset', level: 2, parentId: source });

    const post = (targetId: string) => inTx(h.fx, () => postReclassBatch(h.fx.companyId, h.fx.userId, {
      tool: 'hg_test', sourceAccountId: source, targetAccountId: targetId, postingDate: null, idempotencyKey: null,
      drafts: [{
        date: DATE, description: 'HG reclass', sourceLineIds: [originalLine], totalDebit: 100, totalCredit: 100,
        lines: [{ glAccountId: source, debit: 0, credit: 100 }, { glAccountId: targetId, debit: 100, credit: 0 }],
      }],
    }));
    const err = await refusalOf(post(h.assetHdr.id));
    expect(err.lineIndex).toBe(1);
    expect(err.message).toContain(`Line 2: ${h.assetHdr.code} `);
    const moved = await post(target);
    expect(moved.journals).toHaveLength(1);
    expect(moved.movedLineCount).toBe(1);
  });
});

describeIfDb('POST /api/accounting/journal-entries and the chart-edit race', () => {
  beforeAll(async () => { h = await seedHeaderFixture('HGR', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropHeaderFixture(h); }, 120000);

  it('answers 400 with the message and writes nothing; a leaf posts', async () => {
    const before = await countRows(h.fx);
    const refused = await callRoute(h.fx, h.token, journalEntries,
      { entryDate: DATE, description: 'HG route', lines: pair(h.assetHdr.id) });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(`Line 1: ${h.assetHdr.code} `);
    expect(JSON.stringify(refused.body)).toContain(HEADER_TEXT);
    expect(await countRows(h.fx)).toEqual(before);

    const ok = await callRoute(h.fx, h.token, journalEntries,
      { entryDate: DATE, description: 'HG route', lines: pair(h.leaf) });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(dataOf<{ id: string }>(ok).id).toEqual(expect.any(String));
  });

  it('the guard holds the subject account against a chart edit (FOR UPDATE) until its transaction ends', async () => {
    const a = await h.fx.pool.connect();
    const b = await h.fx.pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '1s'");
      // The leaf asset is level 1 and childless: judged, so locked, and passes.
      await runOn(h.fx, a, () => assertNoHeaderAccountLines(h.fx.companyId, [{ glAccountId: h.leaf }]));
      const blocked = await b.query('SELECT id FROM gl_accounts WHERE id = $1 FOR UPDATE', [h.leaf])
        .then(() => null, (e: unknown) => e);
      expect((blocked as { code?: string } | null)?.code, 'B was not blocked').toBe('55P03');
      await b.query('ROLLBACK');
      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '1s'");
      await a.query('COMMIT');
      const after = await b.query('SELECT id FROM gl_accounts WHERE id = $1 FOR UPDATE', [h.leaf]);
      expect(after.rows).toHaveLength(1);
      await b.query('COMMIT');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });
});
