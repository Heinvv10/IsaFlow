/**
 * Migration 1018, round 14 (L1, the round-13 breaker's P1), as app_user under RLS and claims. One lock order for every
 * path that holds an account row and a journal: the gl_accounts rows first (sorted), then the journal's row, then its
 * key. An account merge takes its accounts FOR UPDATE, then the keys of their journals. A claim and a document's
 * journal lock take FOR KEY SHARE on the accounts of the journal's (and its chain root's) lines first: what the contra's
 * composite FK (gl_account_id, company_id) asks for anyway. So a reversal or a document cancel and a merge on one of
 * the journal's accounts wait for one another instead of deadlocking (40P01), and two reversals on one account do not
 * wait at all (FOR KEY SHARE does not conflict with FOR KEY SHARE).
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { document, dropFreeze, journal, openApp, reverseAsSuperuser, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { code?: string; message: string }) => `${e.code ?? ''} ${e.message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidOf = async (c: PoolClient) => Number((await c.query('SELECT pg_backend_pid() AS p')).rows[0].p);
/** What session `pid` is waiting on right now (null when it is not waiting on a lock), and in which statement. */
const waitOf = async (pid: number) => {
  const r = await one(sql`SELECT wait_event_type AS wt, wait_event AS we, query AS q FROM pg_stat_activity WHERE pid = ${pid}`);
  return r.wt === 'Lock' ? { on: String(r.we), q: String(r.q) } : null;
};
const close = async (c: PoolClient) => { await c.query('ROLLBACK').catch(() => undefined); c.release(); };

/** An account merge's locks as app_user, in mergeAccounts' order: both accounts FOR UPDATE, then the source's journal keys. */
async function mergeLocks(c: PoolClient, source: string, target: string): Promise<void> {
  await c.query('SELECT 1 FROM gl_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[source, target]]);
  await c.query(`SELECT public.ledger_lock_key(j.id) FROM (SELECT DISTINCT journal_entry_id AS id FROM gl_journal_lines
    WHERE company_id = $1 AND gl_account_id = $2 ORDER BY 1 OFFSET 0) j`, [z.f.fx.companyId, source]);
}
/** A draft journal with one line on `account`, written by app_user in `c` (the contra INSERT's FK check on the account). */
async function lineOn(c: PoolClient, account: string): Promise<void> {
  const je = String((await c.query(`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
    VALUES ($1, CURRENT_DATE, 'R14 contra', 'manual', 'draft', $2) RETURNING id`, [z.f.fx.companyId, z.f.fx.userId])).rows[0].id);
  await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 0, 10)',
    [je, z.f.fx.companyId, account]);
}

describeIfDisposable('ledger column immutability, round 14: account rows before journal keys (migration 1018)', () => {
  let acct: (name: string) => Promise<string>;
  beforeAll(async () => {
    z = await seedFreeze();
    acct = async (name) => String((await one(sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, level)
      VALUES (${z.f.fx.companyId}::UUID, ${`69${randomUUID().slice(0, 4)}`}, ${name}, 'expense', 'operating_expense', 'debit', true, 3) RETURNING id`)).id);
  }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it('L1 (P1) a claim, then a merge\'s account locks and key sweep, then the contra line: the merge waits on the account', async () => {
    const src = await acct('R14 P1 src');
    const tgt = await acct('R14 P1 tgt');
    const x = await journal(z, [[src, 10, 0], [z.ap, 0, 10]]);
    const rev = await openApp(z);
    const mrg = await openApp(z);
    const mrgPid = await pidOf(mrg);
    try {
      await rev.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [x, z.f.fx.userId]);
      const merging = settle(mergeLocks(mrg, src, tgt));
      await sleep(500);
      // Waits on the claim's account row (a transactionid wait in the FOR UPDATE), not on X's key while holding the account.
      expect(await waitOf(mrgPid)).toEqual({ on: 'transactionid', q: expect.stringMatching(/FROM gl_accounts .*FOR UPDATE/) });
      expect(await settle(lineOn(rev, src))).toBe('ACCEPTED');
      await rev.query('COMMIT');
      expect(await merging).toBe('ACCEPTED');
    } finally { await close(rev); await close(mrg); }
  }, 30000);

  it('L1 a document cancel takes its journal\'s accounts before the journal: a merge on one of them waits, no deadlock', async () => {
    const src = await acct('R14 cancel src');
    const tgt = await acct('R14 cancel tgt');
    const legs: Leg[] = [[src, 100, 0], [z.revenue, 0, 100]];
    const j = await journal(z, legs, { claimed: true });
    await reverseAsSuperuser(z, j, legs); // out of force: the cancel passes rule 5
    const inv = await document(z, 'customer_invoices', { link: j });
    const doc = await openApp(z);
    const mrg = await openApp(z);
    const mrgPid = await pidOf(mrg);
    try {
      // doc_cancel_in_force: ledger_lock_journal(j), so this transaction holds j's row and key from here.
      await doc.query("UPDATE customer_invoices SET status = 'cancelled' WHERE id = $1", [inv]);
      const merging = settle(mergeLocks(mrg, src, tgt));
      await sleep(500);
      expect(await waitOf(mrgPid)).toEqual({ on: 'transactionid', q: expect.stringMatching(/FROM gl_accounts .*FOR UPDATE/) });
      // The same transaction then writes a line on the journal's account (a re-post after a cancel, say).
      expect(await settle(lineOn(doc, src))).toBe('ACCEPTED');
      await doc.query('COMMIT');
      expect(await merging).toBe('ACCEPTED');
    } finally { await close(doc); await close(mrg); }
  }, 30000);

  it('over-strict: a claim does not wait for another reversal on the same account (its contra line written, still open)', async () => {
    const shared = await acct('R14 shared');
    const a = await journal(z, [[shared, 10, 0], [z.ap, 0, 10]]);
    const b = await journal(z, [[shared, 20, 0], [z.ap, 0, 20]]);
    const r1 = await openApp(z);
    const r2 = await openApp(z);
    try {
      await r1.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [a, z.f.fx.userId]);
      await lineOn(r1, shared);
      const t0 = Date.now();
      await r2.query('SET LOCAL lock_timeout = 1000');
      expect(await settle(r2.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [b, z.f.fx.userId]))).toBe('ACCEPTED');
      expect(Date.now() - t0).toBeLessThan(900);
    } finally { await close(r1); await close(r2); }
  }, 30000);
});
