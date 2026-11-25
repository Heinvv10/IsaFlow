/**
 * Migration 1018, round 13 (L1), through the real services as the production-shaped login (helpers/appLoginWorld).
 * reverseJournalEntry takes every chain it touches (the journal's, and a late-claim companion's) rows and keys in
 * sorted order BEFORE its claim, so it never holds a chain key while waiting for a lower one; and an account merge that
 * meets a held key says so (not "the chart of accounts is being changed").
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, journal, negate, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';
import { draftBill, dropLateFixture, lockPeriod, P, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let late: LateFixture;
let world: AppWorld;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { code?: string; message: string }) => `${e.code ?? ''} ${e.message}`);

/** A superuser session holding one journal's link key until released. */
async function holdKey(je: string): Promise<PoolClient> {
  const c = await z.pool.connect();
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(public.ledger_link_key($1))', [je]);
  return c;
}
const release = async (c: PoolClient) => { await c.query('ROLLBACK').catch(() => undefined); c.release(); };
/** The statement the world's login is waiting in, on an advisory lock. */
const waitingIn = async () => ((await sql`SELECT query FROM pg_stat_activity
  WHERE usename = ${world.login} AND wait_event_type = 'Lock' AND wait_event = 'advisory'`) as Row[]).map((r) => String(r.query));
/** Has the waiting request written a journal yet (a claim or a contra holds RowExclusiveLock on the table)? */
const wroteJournals = async () => Number((await one(sql`SELECT count(*)::int AS n FROM pg_locks l
  JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE a.usename = ${world.login} AND l.relation = 'public.gl_journal_entries'::regclass AND l.mode = 'RowExclusiveLock'`)).n);

describeIfDisposable('ledger column immutability, round 13: reversal lock order as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    late = await seedLateFixture('LF13', process.env.DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${late.userId}, ${`lf13-${late.userId}@isaflow.test`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${late.companyId}::UUID, ${late.userId}, 'admin')`;
    await lockPeriod(late, P.start, P.end);
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => {
    if (world) await world.close();
    if (late) {
      await sql`DELETE FROM company_document_numbers WHERE company_id = ${late.companyId}::UUID`;
      await sql`DELETE FROM company_users WHERE company_id = ${late.companyId}::UUID`;
      await sql`DELETE FROM users WHERE id = ${late.userId}`;
      await dropLateFixture(late);
    }
    if (z) {
      await sql`DELETE FROM gl_account_merges WHERE company_id = ${z.f.fx.companyId}::UUID`;
      await dropFreeze(z);
    }
  }, 120000);

  it('L1 a re-reversal waits for its chain root\'s key in the claim, before it holds the claimed journal\'s key', async () => {
    const legs: Leg[] = [[z.ar, 100, 0], [z.revenue, 0, 100]];
    const y = await journal(z, legs);
    const x = await journal(z, negate(legs));
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${y}::UUID WHERE id = ${x}::UUID`;
    const who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const h = await holdKey(y);
    let reversing: Promise<string> | undefined;
    try {
      reversing = settle(world.run(who, () => reverseJournalEntry(z.f.fx.companyId, x, z.f.fx.userId)));
      await new Promise((r) => setTimeout(r, 800));
      // In the claim (its trigger takes Y's key before X's), not in the link holding X's key while it waits for Y's.
      const waiting = await waitingIn();
      expect(waiting).toEqual([expect.stringMatching(/SET reversed_by/)]);
      expect(waiting[0]).not.toMatch(/reversal_of_id/);
    } finally { await release(h); }
    expect(await reversing).toBe('ACCEPTED');
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${x}::UUID`)).n).toBe(1);
  }, 30000);

  it('L1 a late-claim reversal takes the companion\'s chain with the original\'s, before either claim', async () => {
    const who = { userId: late.userId, companyId: late.companyId };
    const { approveSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService'));
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const bill = await draftBill(late, '2026-06-12');
    const approved = await world.run(who, () => approveSupplierInvoice(late.companyId, bill.id, late.userId, { allowLateInputClaim: true }));
    const companion = approved.lateClaim!.companionEntryId;
    const original = String((await one(sql`SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill.id}::UUID`)).je);
    const h = await holdKey(companion);
    let reversing: Promise<string> | undefined;
    try {
      reversing = settle(world.run(who, () => reverseJournalEntry(late.companyId, original, late.userId)));
      await new Promise((r) => setTimeout(r, 800));
      expect(await waitingIn()).toEqual([expect.stringMatching(/ledger_lock_chains/)]); // not in the companion's claim
      expect(await wroteJournals()).toBe(0); // nor after the original's claim and contra: the companion's chain was taken with it
    } finally { await release(h); }
    expect(await reversing).toBe('ACCEPTED');
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${companion}::UUID`)).n).toBe(1);
  }, 30000);

  it('L1 a merge that meets a journal key held past the bound says the journals are busy, not the chart', async () => {
    const acct = async (name: string) => String((await one(sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, level)
      VALUES (${z.f.fx.companyId}::UUID, ${`69${randomUUID().slice(0, 4)}`}, ${name}, 'expense', 'operating_expense', 'debit', true, 3) RETURNING id`)).id);
    const source = await acct('R13 merge source');
    const target = await acct('R13 merge target');
    const je = await journal(z, [[source, 10, 0], [z.ap, 0, 10]]);
    const { mergeAccounts } = await world.load(() => import('@/modules/accounting/services/gl/accountMergeService'));
    const h = await holdKey(je);
    try {
      const out = await settle(world.run({ userId: z.f.fx.userId, companyId: z.f.fx.companyId }, () => mergeAccounts(z.f.fx.companyId, source, target, z.f.fx.userId)));
      expect(out).toMatch(/^JOURNAL_LINK_KEYS_LOCK_TIMEOUT Journals on this account are being reversed or linked by another request/);
    } finally { await release(h); }
  }, 30000);
});
