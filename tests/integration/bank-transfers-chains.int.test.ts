/**
 * Bank transfers (PR #670, brk-nrfa rounds 11-14, sec-nrfa rounds 10-12): the transfer guard on reversal chains — a
 * bounce matched to a reversal, forged reversal_of_id rows (cross-tenant, loops, loops longer than the walk bound), and a
 * real reversal chain deeper than 20. Split from bank-transfers-pairing (file size).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import bankTxAction from '../../pages/api/accounting/bank-transactions-action';
import bankMatchConfirm from '../../pages/api/accounting/bank-match-confirm';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture } from './helpers/l1FifoFixture';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let c: DateFixture;
let token = '';
let bankA = '';
let bankB = '';

const transferJournals = async (from: string, to: string) => (await sql`SELECT id, entry_number, entry_date::text AS d,
  status, reversal_of_id, reference FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID
  AND source = 'auto_bank_transfer' AND entry_date BETWEEN ${from}::DATE AND ${to}::DATE ORDER BY created_at`) as Row[];
const glMovement = async (acct: string, from: string, to: string) => Number(((await sql`
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::float8 AS n FROM gl_journal_lines jl
  JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = ${c.fx.companyId}::UUID
  WHERE jl.company_id = ${c.fx.companyId}::UUID AND jl.gl_account_id = ${acct}::UUID AND je.status IN ('posted', 'reversed')
    AND je.entry_date BETWEEN ${from}::DATE AND ${to}::DATE`) as Row[])[0]!.n);
const bankLine = async (account: string, date: string, amount: number, desc: string) => String(((await sql`
  INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
    import_batch_id)
  VALUES (${c.fx.companyId}::UUID, ${account}::UUID, ${date}::DATE, ${amount}, ${`${desc} ${c.fx.tag}`}, 'imported',
    gen_random_uuid())
  RETURNING id`) as Row[])[0]!.id);
const allocTransfer = (line: string, contra: string) => callRoute(c.fx, token, bankTxAction,
  { action: 'allocate', bankTransactionId: line, allocationType: 'transfer', contraAccountId: contra });
const lineOf = async (je: string, acct: string) => String(((await sql`SELECT id FROM gl_journal_lines
  WHERE journal_entry_id = ${je}::UUID AND gl_account_id = ${acct}::UUID AND company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.id);
const lineState = async (id: string) => ((await sql`SELECT status, matched_journal_line_id AS m,
  transfer_journal_entry_id AS ptr FROM bank_transactions WHERE id = ${id}::UUID`) as Row[])[0];

describeIfDb('the transfer guard on reversal chains', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('CHAIN', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'chain');
    bankA = c.fx.bankAccountId;
    bankB = String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      account_subtype, normal_balance, is_active) VALUES (${c.fx.companyId}::UUID, '1010', 'PAIR Savings', 'asset', 'bank',
      'debit', true) RETURNING id`) as Row[])[0]!.id);
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID`;
    await dropRouteUser(c.fx);
    await dropFixture(c.fx);
  }, 60000);

  const confirm = (line: string, leg: string) => callRoute(c.fx, token, bankMatchConfirm,
    { bankTransactionId: line, candidateType: 'bank_transfer', candidateId: leg });
  const glReverse = async (je: string) => {
    const r = await callRoute(c.fx, token, journalEntriesAction, { id: je, action: 'reverse' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    return String((r.body as { data: { id: string } }).data.id);
  };

  // sec-nrfa round 10 L1/L2: arm 1's root walk is bounded and takes the deepest member this company owns, so a forged
  // cross-tenant reversal_of_id on the pointer journal does not drop the line (the duplicate is still refused), and a
  // forged reversal loop does not hang the allocation.
  it('a forged reversal_of_id (cross-tenant, or a loop) neither drops the line nor hangs arm 1', async () => {
    const other = await seedDateFixture('PAIRX', DATABASE_URL!);
    const foreign = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, source,
      created_by) VALUES (${other.fx.companyId}::UUID, '2029-03-01', 'PAIRX other tenant', 'draft', 'manual',
      ${other.fx.userId}::UUID) RETURNING id`) as Row[])[0]!.id);
    const a = await bankLine(bankA, '2029-03-05', -5000, 'W1 OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    const j1 = String((await lineState(a))!.ptr);
    const b = await bankLine(bankB, '2029-03-06', 5000, 'W1 IN');
    try {
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${foreign}::UUID WHERE id = ${j1}::UUID`;
      expect((await allocTransfer(b, bankA)).statusCode).toBe(400);
      const j2 = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, source,
        created_by) VALUES (${c.fx.companyId}::UUID, '2029-03-05', 'PAIR loop', 'draft', 'manual', ${c.fx.userId}::UUID)
        RETURNING id`) as Row[])[0]!.id);
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${j2}::UUID WHERE id = ${j1}::UUID`;
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${j1}::UUID WHERE id = ${j2}::UUID`;
      const started = Date.now();
      expect((await allocTransfer(b, bankA)).statusCode).toBe(400);
      expect(Date.now() - started).toBeLessThan(15000);
      await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE id IN (${j1}::UUID, ${j2}::UUID)`;
      await sql`DELETE FROM gl_journal_entries WHERE id = ${j2}::UUID AND status = 'draft'`;
    } finally {
      await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE id = ${j1}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE id = ${foreign}::UUID AND status = 'draft'`;
      await dropFixture(other.fx);
    }
    expect(await glMovement(bankB, '2029-03-01', '2029-03-31')).toBe(5000);
  }, 120000);

  // brk-nrfa round 11 M1: a transfer J1 bounced — reversed in the GL (R1) — and each bank's bounce line arrives. One
  // bounce is matched to R1's leg (the match screen offers it first); the other, allocated as a transfer, is the same
  // reversed movement and is refused. A pointer at a reversal (an odd step) never lends it J1's pairing.
  it('a bounce matched to a reversal does not pair the original for the other bounce (both sides)', async () => {
    for (const [date, amt, firstBank] of [['2029-04-02', 5100, 'A'], ['2029-04-09', 5200, 'B']] as const) {
      const aOut = await bankLine(bankA, date, -amt, `O1 A OUT ${date}`);
      await bankLine(bankB, date, amt, `O1 B IN ${date}`); // auto-linked by the allocation below
      expect((await allocTransfer(aOut, bankB)).statusCode).toBe(200);
      const r1 = await glReverse(String((await lineState(aOut))!.ptr));
      const next = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
      const aBack = await bankLine(bankA, next, amt, `O1 A IN ${next}`);
      const bBack = await bankLine(bankB, next, -amt, `O1 B OUT ${next}`);
      const [matched, matchedBank, other, contra] = firstBank === 'A'
        ? [aBack, bankA, bBack, bankA] : [bBack, bankB, aBack, bankB];
      expect((await confirm(matched, await lineOf(r1, matchedBank))).statusCode).toBe(200);
      expect((await allocTransfer(other, contra)).statusCode).toBe(400);
      // Only J1 itself: the refused bounce posted no second transfer.
      expect((await transferJournals(date, next)).filter((j) => j.reversal_of_id === null)).toHaveLength(1);
    }
  }, 180000);

  // sec-nrfa round 11 L1: a forged odd-length loop (J1 -> J2 -> J3 -> J1) has no root; J1's pointer anchors at J1
  // itself, so B lines legitimately matched to J2's and J3's legs do not pair J1 and J1's duplicate is still refused.
  it('a forged three-journal loop does not lend one transfer another one\'s pairing', async () => {
    const outs = [await bankLine(bankA, '2029-05-02', -5400, 'V2 OUT 1'), await bankLine(bankA, '2029-05-02', -5500, 'V2 OUT 2'),
      await bankLine(bankA, '2029-05-02', -5600, 'V2 OUT 3')];
    for (const a of outs) expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    const [j1, j2, j3] = await Promise.all(outs.map(async (a) => String((await lineState(a))!.ptr)));
    expect((await confirm(await bankLine(bankB, '2029-05-03', 5500, 'V2 IN 2'), await lineOf(j2!, bankB))).statusCode).toBe(200);
    expect((await confirm(await bankLine(bankB, '2029-05-03', 5600, 'V2 IN 3'), await lineOf(j3!, bankB))).statusCode).toBe(200);
    const b1 = await bankLine(bankB, '2029-05-03', 5400, 'V2 IN 1');
    expect((await allocTransfer(b1, bankA)).statusCode).toBe(400);
    try {
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${j2!}::UUID WHERE id = ${j1!}::UUID`;
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${j3!}::UUID WHERE id = ${j2!}::UUID`;
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${j1!}::UUID WHERE id = ${j3!}::UUID`;
      expect((await allocTransfer(b1, bankA)).statusCode).toBe(400);
    } finally {
      await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE id IN (${j1!}::UUID, ${j2!}::UUID, ${j3!}::UUID)`;
    }
  }, 120000);

  // brk-nrfa round 13 L1: a forged loop longer than the walk's bound never repeats inside it; a walk that ends at the
  // bound with a parent still to go is as unresolved as a loop, so the pointer anchors at itself.
  it('a forged loop longer than the walk bound does not lend another transfer\'s pairing', async () => {
    const D = '2029-06-04';
    const outs: string[] = [];
    for (let i = 0; i < 22; i++) {
      const a = await bankLine(bankA, D, -(6000 + i), `L22 A OUT ${i}`);
      expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
      outs.push(a);
    }
    const j: string[] = [];
    for (const a of outs) j.push(String((await lineState(a))!.ptr));
    expect((await confirm(await bankLine(bankB, D, 6002, 'L22 B IN 2'), await lineOf(j[2]!, bankB))).statusCode).toBe(200);
    const b0 = await bankLine(bankB, D, 6000, 'L22 B IN 0');
    expect((await allocTransfer(b0, bankA)).statusCode).toBe(400);
    try {
      for (let i = 0; i < 22; i++) {
        await sql`UPDATE gl_journal_entries SET reversal_of_id = ${j[(i + 1) % 22]!}::UUID WHERE id = ${j[i]!}::UUID`;
      }
      expect((await allocTransfer(b0, bankA)).statusCode).toBe(400);
    } finally {
      await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE id = ANY(${j}::UUID[])`;
    }
  }, 300000);

  // brk-nrfa round 14 L1: a REAL reversal chain deeper than 20 (reversals of reversals through the routes) is walked to
  // its root (bound 64), so a line matched within it pairs the movement and the next real sweep posts.
  it('a real 22-deep reversal chain is walked to its root and the next sweep posts', async () => {
    const D = '2029-07-02';
    const aMon = await bankLine(bankA, D, -7221, 'LC A OUT MON');
    expect((await allocTransfer(aMon, bankB)).statusCode).toBe(200);
    const j0 = String((await lineState(aMon))!.ptr);
    // Reversed from Banking (frees the line: R1), then each reversal reversed in the GL, to R22 (live: J0 stands).
    expect((await callRoute(c.fx, token, bankTxAction, { action: 'reverse', bankTransactionId: aMon })).statusCode).toBe(200);
    const chain = [j0, String(((await sql`SELECT id FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID
      AND reversal_of_id = ${j0}::UUID`) as Row[])[0]!.id)];
    for (let i = 1; i < 22; i++) chain.push(await glReverse(chain[i]!));
    expect((await confirm(aMon, await lineOf(chain[22]!, bankA))).statusCode).toBe(200);
    const bMon = await bankLine(bankB, D, 7221, 'LC B IN MON');
    expect((await confirm(bMon, await lineOf(chain[2]!, bankB))).statusCode).toBe(200);
    await bankLine(bankA, '2029-07-03', -7221, 'LC A OUT TUE');
    expect((await allocTransfer(await bankLine(bankB, '2029-07-03', 7221, 'LC B IN TUE'), bankA)).statusCode).toBe(200);
  }, 600000);
});
