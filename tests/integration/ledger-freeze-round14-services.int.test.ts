/**
 * Migration 1018, round 14 (L1, the round-13 breaker's P2), through the real services as the production-shaped login
 * (helpers/appLoginWorld). A reversal, a re-reversal, a document cancel and a late-claim pair each race an account
 * merge on one of the reversed journal's accounts. Each reversal is paused after its claim (a superuser holds the
 * company row FOR UPDATE, so the contra INSERT's company FK check waits), the merge starts, then the hold goes.
 * Before round 14 the reversal held the journal's link key and then asked for the account (the contra's composite FK)
 * while the merge held the account FOR UPDATE and asked for the key: 40P01. Now the claim takes the accounts first, so
 * the merge waits on the account row, and both finish.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { document, dropFreeze, journal, negate, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';
import { draftBill, dropLateFixture, lockPeriod, P, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let late: LateFixture;
let world: AppWorld;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { code?: string; message: string }) => `${e.code ?? ''} ${e.message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newAccount = async (companyId: string, name: string) => String((await one(sql`INSERT INTO gl_accounts (company_id, account_code,
    account_name, account_type, account_subtype, normal_balance, is_active, level)
  VALUES (${companyId}::UUID, ${`69${randomUUID().slice(0, 4)}`}, ${name}, 'expense', 'operating_expense', 'debit', true, 3) RETURNING id`)).id);
/** The statements the world's login is waiting in, and on what. */
const waits = async () => ((await sql`SELECT wait_event AS we, query AS q FROM pg_stat_activity
  WHERE usename = ${world.login} AND wait_event_type = 'Lock'`) as Row[]).map((r) => ({ on: String(r.we), q: String(r.q) }));

/**
 * Run `reverse` paused after its claim, start a merge of `source` into a fresh account of `companyId`, and release.
 * Returns both outcomes, and where the merge waited while the reversal was paused.
 */
async function raceMerge(companyId: string, userId: string, source: string, reverse: () => Promise<unknown>) {
  const target = await newAccount(companyId, 'R14 merge target');
  const who = { userId, companyId };
  const { mergeAccounts } = await world.load(() => import('@/modules/accounting/services/gl/accountMergeService'));
  const hold: PoolClient = await z.pool.connect();
  await hold.query('BEGIN');
  await hold.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  let reversing: Promise<string> | undefined;
  let merging: Promise<string> | undefined;
  let mergeWait: { on: string; q: string } | undefined;
  try {
    reversing = settle(world.run(who, reverse));
    await sleep(1200);
    merging = settle(world.run(who, () => mergeAccounts(companyId, source, target, userId)));
    await sleep(1200);
    mergeWait = (await waits()).find((w) => !/INSERT INTO gl_journal_entries/.test(w.q));
  } finally { await hold.query('ROLLBACK').catch(() => undefined); hold.release(); }
  return { reversal: await reversing!, merge: await merging!, mergeWait };
}

describeIfDisposable('ledger column immutability, round 14: a reversal and an account merge wait, never deadlock (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    late = await seedLateFixture('LF14', process.env.DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${late.userId}, ${`lf14-${late.userId}@isaflow.test`}, 'admin', true)`;
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

  const expectWaitedThenBoth = (r: Awaited<ReturnType<typeof raceMerge>>) => {
    expect(r.mergeWait).toEqual({ on: 'transactionid', q: expect.stringMatching(/FROM gl_accounts/) }); // the account row, not a key
    expect(r.reversal).toBe('ACCEPTED');
    expect(r.merge).toBe('ACCEPTED');
  };

  it('L1 (P2) reverseJournalEntry and mergeAccounts on the reversed journal\'s account', async () => {
    const src = await newAccount(z.f.fx.companyId, 'R14 P2 src');
    const x = await journal(z, [[src, 10, 0], [z.ap, 0, 10]]);
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    expectWaitedThenBoth(await raceMerge(z.f.fx.companyId, z.f.fx.userId, src, () => reverseJournalEntry(z.f.fx.companyId, x, z.f.fx.userId)));
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${x}::UUID`)).n).toBe(1);
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_lines WHERE gl_account_id = ${src}::UUID`)).n).toBe(0); // all moved
  }, 60000);

  it('L1 a re-reversal (reversing a contra) and a merge on the chain\'s account', async () => {
    const src = await newAccount(z.f.fx.companyId, 'R14 re-reversal src');
    const legs: Leg[] = [[src, 40, 0], [z.ap, 0, 40]];
    const y = await journal(z, legs, { claimed: true });
    const x = await journal(z, negate(legs));
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${y}::UUID WHERE id = ${x}::UUID`;
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    expectWaitedThenBoth(await raceMerge(z.f.fx.companyId, z.f.fx.userId, src, () => reverseJournalEntry(z.f.fx.companyId, x, z.f.fx.userId)));
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${x}::UUID`)).n).toBe(1);
  }, 60000);

  it('L1 a customer invoice cancel (reverse, then cancel) and a merge on the invoice journal\'s account', async () => {
    const src = await newAccount(z.f.fx.companyId, 'R14 cancel src');
    const j = await journal(z, [[z.ar, 100, 0], [src, 0, 100]]);
    const inv = await document(z, 'customer_invoices', { link: j });
    const { cancelCustomerInvoice } = await world.load(() => import('@/modules/accounting/services/ar/customerInvoiceCancelService'));
    expectWaitedThenBoth(await raceMerge(z.f.fx.companyId, z.f.fx.userId, src, () => cancelCustomerInvoice(z.f.fx.companyId, inv, z.f.fx.userId, { allowReversal: true })));
    expect(await one(sql`SELECT status, gl_journal_entry_id AS je FROM customer_invoices WHERE id = ${inv}::UUID`)).toEqual({ status: 'cancelled', je: null });
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${j}::UUID`)).n).toBe(1);
  }, 60000);

  it('L1 a late-claim pair (two chains, taken before either claim) and a merge on the original\'s expense account', async () => {
    const src = await newAccount(late.companyId, 'R14 late src');
    const who = { userId: late.userId, companyId: late.companyId };
    const { approveSupplierInvoice } = await world.load(() => import('@/modules/accounting/services/ap/supplierInvoiceWorkflowService'));
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const bill = await draftBill(late, '2026-06-12', { glAccountId: src });
    const approved = await world.run(who, () => approveSupplierInvoice(late.companyId, bill.id, late.userId, { allowLateInputClaim: true }));
    const companion = approved.lateClaim!.companionEntryId;
    const original = String((await one(sql`SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = ${bill.id}::UUID`)).je);
    expectWaitedThenBoth(await raceMerge(late.companyId, late.userId, src, () => reverseJournalEntry(late.companyId, original, late.userId)));
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id IN (${original}::UUID, ${companion}::UUID)`)).n).toBe(2);
  }, 90000);
});
