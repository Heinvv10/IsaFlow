/**
 * A move UP that re-levels a posted level-3 parent to 2, and a journal posting to that parent on another connection,
 * serialise in either order (PR #701 breaker REPRO 3): without it both commit and a level-2 account with a child
 * carries lines the balance sheet drops.
 *
 * Two pg clients, each in its own transaction under the app's ALS, as a request runs. The tree is
 * R1 (1) > R2 (2) > R3 (3, a child R4); the move promotes R2 to the top, which would take R3 to level 2.
 *  - MOVE FIRST (uncommitted): the post must WAIT (on the guard's KEY SHARE of the parent, against the move's FOR
 *    UPDATE), and once the move commits it is refused with HeaderAccountRefusal;
 *  - POST FIRST (uncommitted): the move must WAIT, and once the post commits it is refused ("would put … above level 3").
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { reclassifyAccount } from '@/modules/accounting/services/gl/accountReclassifyService';
import { HeaderAccountRefusal } from '@/modules/accounting/services/gl/headerAccountGuard';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { runOn } from './helpers/l1FifoFixture';
import { addAccount, dropHeaderFixture, seedHeaderFixture, type HeaderFixture } from './helpers/headerGuardFixture';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
const DATE = '2026-07-10';
const WAIT_MS = 1500;
let h: HeaderFixture;

const tree = async (tag: string) => {
  const r1 = await addAccount(h.fx, { code: `HGR-${tag}1`, type: 'asset', level: 1 });
  const r2 = await addAccount(h.fx, { code: `HGR-${tag}2`, type: 'asset', level: 2, parentId: r1 });
  const r3 = await addAccount(h.fx, { code: `HGR-${tag}3`, type: 'asset', level: 3, parentId: r2 });
  await addAccount(h.fx, { code: `HGR-${tag}4`, type: 'asset', level: 4, parentId: r3 });
  return { r2, r3 };
};

const postTo = (account: string) => async () => {
  const e = await createJournalEntry(h.fx.companyId, {
    entryDate: DATE, description: 'HGR', source: 'manual',
    lines: [{ glAccountId: account, debit: 100, credit: 0 }, { glAccountId: h.fx.bankAccountId, debit: 0, credit: 100 }],
  }, h.fx.userId);
  await postJournalEntry(h.fx.companyId, e.id, h.fx.userId);
};

/** Starts `fn` on `client` without awaiting it, and reports whether it has settled. */
function start<T>(client: PoolClient, fn: () => Promise<T>) {
  const state = { settled: false };
  const outcome = runOn(h.fx, client, fn).then(
    () => null, (e: unknown) => e as Error,
  ).finally(() => { state.settled = true; });
  return { state, outcome };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Accounts below level 3, with a child, carrying lines: what the balance sheet drops. */
const hiddenWithLines = async (): Promise<number> => Number((((await sql`
  SELECT COUNT(*)::INT AS n FROM gl_accounts a
   WHERE a.company_id = ${h.fx.companyId}::UUID AND a.account_type IN ('asset', 'liability', 'equity') AND a.level < 3
     AND EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_account_id = a.id)
     AND EXISTS (SELECT 1 FROM gl_journal_lines l WHERE l.gl_account_id = a.id)`) as Record<string, unknown>[])[0]!).n);

async function twoClients(run: (a: PoolClient, b: PoolClient) => Promise<void>): Promise<void> {
  const a = await h.fx.pool.connect();
  const b = await h.fx.pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await b.query("SET LOCAL lock_timeout = '10s'");
    await run(a, b);
  } finally {
    await a.query('ROLLBACK').catch(() => undefined);
    await b.query('ROLLBACK').catch(() => undefined);
    a.release();
    b.release();
  }
}

describeIfDb('a move-up and a post to the parent it re-levels serialise in either order', () => {
  beforeAll(async () => { h = await seedHeaderFixture('HGQ', process.env.DATABASE_URL!); }, 120000);
  afterAll(async () => { await dropHeaderFixture(h); }, 120000);

  it('MOVE first (uncommitted): the post waits, then is refused with HeaderAccountRefusal', async () => {
    const t = await tree('M');
    await twoClients(async (a, b) => {
      expect(await runOn(h.fx, a, () => reclassifyAccount(h.fx.companyId, t.r2, { parentAccountId: null })
        .then(() => null, (e: unknown) => e as Error))).toBeNull();
      const post = start(b, postTo(t.r3));
      await pause(WAIT_MS);
      expect(post.state.settled, 'the post did not wait for the move').toBe(false);
      await a.query('COMMIT');
      const err = await post.outcome;
      expect(err, 'the post was not refused').toBeInstanceOf(HeaderAccountRefusal);
      expect(err!.message).toContain('Line 1: HGR-M3 ');
      await b.query('ROLLBACK');
    });
    expect(await hiddenWithLines()).toBe(0);
    expect(Number(((await sql`SELECT level FROM gl_accounts WHERE id = ${t.r3}::UUID`) as Record<string, unknown>[])[0]!.level)).toBe(2);
  }, 120000);

  it('POST first (uncommitted): the move waits, then is refused ("would put … above level 3")', async () => {
    const t = await tree('P');
    await twoClients(async (a, b) => {
      await runOn(h.fx, a, postTo(t.r3));
      const move = start(b, () => reclassifyAccount(h.fx.companyId, t.r2, { parentAccountId: null }));
      await pause(WAIT_MS);
      expect(move.state.settled, 'the move did not wait for the post').toBe(false);
      await a.query('COMMIT');
      const err = await move.outcome;
      expect(err, 'the move was not refused').not.toBeNull();
      expect(err!.message).toContain('would put HGR-P3 above level 3');
      await b.query('ROLLBACK');
    });
    expect(await hiddenWithLines()).toBe(0);
    expect(Number(((await sql`SELECT level FROM gl_accounts WHERE id = ${t.r3}::UUID`) as Record<string, unknown>[])[0]!.level)).toBe(3);
  }, 120000);
});
