/**
 * Bank transfers (PR #670, brk-nrfa round 8, sec-nrfa round 7): which line pairs a transfer journal, and what
 * Receive/Spend Money answers when it refuses. A line that clears a week after its transfer still pairs it; a match to
 * a live re-reversal pairs like one to the journal; a hand-keyed line never pairs a journal a statement created; the
 * manual route answers a closed period and an over-credit refund 400 and leaves no line behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import bankTxAction from '../../pages/api/accounting/bank-transactions-action';
import bankMatchConfirm from '../../pages/api/accounting/bank-match-confirm';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import bankTxManual from '../../pages/api/accounting/bank-transactions-manual';
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

describeIfDb('which line pairs a transfer, and what the manual route refuses', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('PAIR', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'pair');
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
  const typed = (amount: number, date: string) => callRoute(c.fx, token, bankTransfers,
    { fromAccountId: bankA, toAccountId: bankB, amount, transferDate: date });
  const glReverse = async (je: string) => {
    const r = await callRoute(c.fx, token, journalEntriesAction, { id: je, action: 'reverse' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    return String((r.body as { data: { id: string } }).data.id);
  };
  const manual = (body: Record<string, unknown>) => callRoute(c.fx, token, bankTxManual, body);
  const linesNamed = async (desc: string) => Number(((await sql`SELECT COUNT(*)::int AS n FROM bank_transactions
    WHERE company_id = ${c.fx.companyId}::UUID AND description = ${desc}`) as Row[])[0]!.n);

  // brk-nrfa round 8 L1: the first transfer's B line cleared six days later and was matched to it; a real second
  // transfer of the amount within the week posts — the pairing line is within ten days, not five.
  it('a line clearing a week after its transfer still pairs it (typed and statement transfers)', async () => {
    expect((await typed(3300, '2028-05-04')).statusCode).toBe(200);
    const t = String((await transferJournals('2028-05-04', '2028-05-04'))[0]!.id);
    expect((await confirm(await bankLine(bankB, '2028-05-10', 3300, 'W1 IN late'), await lineOf(t, bankB))).statusCode).toBe(200);
    await bankLine(bankA, '2028-05-06', -3300, 'W1 OUT 2nd');
    expect((await allocTransfer(await bankLine(bankB, '2028-05-06', 3300, 'W1 IN 2nd'), bankA)).statusCode).toBe(200);
    expect(await glMovement(bankB, '2028-05-01', '2028-05-31')).toBe(6600);

    const a1 = await bankLine(bankA, '2028-06-02', -3400, 'W2 OUT 1');
    expect((await allocTransfer(a1, bankB)).statusCode).toBe(200);
    const j1 = String((await lineState(a1))!.ptr);
    expect((await confirm(await bankLine(bankB, '2028-06-08', 3400, 'W2 IN late'), await lineOf(j1, bankB))).statusCode).toBe(200);
    await bankLine(bankA, '2028-06-03', -3400, 'W2 OUT 2');
    expect((await allocTransfer(await bankLine(bankB, '2028-06-03', 3400, 'W2 IN 2'), bankA)).statusCode).toBe(200);
    expect(await glMovement(bankB, '2028-06-01', '2028-06-30')).toBe(6800);
  }, 120000);

  // brk-nrfa round 8 L2: the person follows the refusal's advice and matches the line to the live re-reversal (the
  // match screen offers it); that pairs the movement, so the next real transfer of the amount posts.
  it('a match to a live re-reversal pairs the transfer (statement and typed)', async () => {
    const aMon = await bankLine(bankA, '2028-07-17', -3700, 'R1b OUT MON');
    await bankLine(bankB, '2028-07-17', 3700, 'R1b IN MON'); // auto-linked to J1 by the allocation below
    expect((await allocTransfer(aMon, bankB)).statusCode).toBe(200);
    const j1 = String((await lineState(aMon))!.ptr);
    expect((await callRoute(c.fx, token, bankTxAction, { action: 'reverse', bankTransactionId: aMon })).statusCode).toBe(200);
    const r1 = String(((await sql`SELECT id FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID
      AND reversal_of_id = ${j1}::UUID`) as Row[])[0]!.id);
    const r2 = await glReverse(r1);
    expect((await allocTransfer(aMon, bankB)).statusCode).toBe(400);
    expect((await confirm(aMon, await lineOf(r2, bankA))).statusCode).toBe(200);
    expect((await allocTransfer(await bankLine(bankA, '2028-07-18', -3700, 'R1b OUT TUE'), bankB)).statusCode).toBe(200);
    expect(await glMovement(bankB, '2028-07-17', '2028-07-31')).toBe(7400);

    expect((await typed(3600, '2028-08-01')).statusCode).toBe(200);
    const t = String((await transferJournals('2028-08-01', '2028-08-01'))[0]!.id);
    const t2 = await glReverse(await glReverse(t));
    const b1 = await bankLine(bankB, '2028-08-01', 3600, 'R2 IN 1');
    expect((await allocTransfer(b1, bankA)).statusCode).toBe(400);
    expect((await confirm(b1, await lineOf(t2, bankB))).statusCode).toBe(200);
    await bankLine(bankA, '2028-08-03', -3600, 'R2 OUT 2');
    expect((await allocTransfer(await bankLine(bankB, '2028-08-03', 3600, 'R2 IN 2'), bankA)).statusCode).toBe(200);
    expect(await glMovement(bankB, '2028-08-01', '2028-08-31')).toBe(7200);
  }, 120000);

  // sec-nrfa round 7 L1: a hand-keyed line matched to a statement transfer's leg does not pair it for another
  // hand-keyed copy of the movement.
  it('a hand-keyed line never pairs a journal the statement created', async () => {
    const a = await bankLine(bankA, '2028-09-04', -5900, 'X2 OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    const j1 = String((await lineState(a))!.ptr);
    // A hand-keyed line of the amount, matched by hand to J1's B leg.
    const own = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${bankB}::UUID, '2028-09-04', 5900, ${`X2 hk ${c.fx.tag}`},
      'imported') RETURNING id`) as Row[])[0]!.id);
    expect((await confirm(own, await lineOf(j1, bankB))).statusCode).toBe(200);
    const again = await manual({ type: 'receive', bankAccountId: bankB, date: '2028-09-05', amount: 5900,
      description: `X2 hk 2 ${c.fx.tag}`, allocationType: 'transfer', contraAccountId: bankA });
    expect(again.statusCode, JSON.stringify(again.body)).toBe(400);
    expect(await glMovement(bankB, '2028-09-01', '2028-09-30')).toBe(5900);
  }, 120000);

  // brk-nrfa round 8 L3: Receive/Spend Money answers a closed period and an over-credit supplier refund 400 with the
  // reason, as the allocate action does, and the line it inserted first is rolled back.
  it('the manual route answers a closed period, an inactive account and an over-credit refund 400, leaving no line', async () => {
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${c.fx.companyId}::UUID AND fiscal_year = 2025`;
    try {
      for (const [allocationType, contraAccountId, d] of [['account', c.expense, 'M2 closed'], ['transfer', bankB, 'M2 closed t']]) {
        const r = await manual({ type: 'spend', bankAccountId: bankA, date: '2025-06-10', amount: 140,
          description: `${d} ${c.fx.tag}`, allocationType, contraAccountId });
        expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
        expect(await linesNamed(`${d} ${c.fx.tag}`)).toBe(0);
      }
    } finally {
      await sql`UPDATE fiscal_periods SET status = 'open' WHERE company_id = ${c.fx.companyId}::UUID AND fiscal_year = 2025`;
    }
    // An inactive contra account (rev-nrfa round 8 LOW 1).
    const idle = String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      normal_balance, is_active) VALUES (${c.fx.companyId}::UUID, '6999', 'PAIR Retired', 'expense', 'debit', false)
      RETURNING id`) as Row[])[0]!.id);
    const inactive = await manual({ type: 'spend', bankAccountId: bankA, date: '2028-10-09', amount: 77,
      description: `M5 inactive ${c.fx.tag}`, allocationType: 'account', contraAccountId: idle });
    expect(inactive.statusCode, JSON.stringify(inactive.body)).toBe(400);
    expect(await linesNamed(`M5 inactive ${c.fx.tag}`)).toBe(0);
    const refund = await manual({ type: 'receive', bankAccountId: bankA, date: '2028-10-10', amount: 99999,
      description: `M4 refund ${c.fx.tag}`, allocationType: 'supplier', entityId: c.fx.supplierId });
    expect(refund.statusCode, JSON.stringify(refund.body)).toBe(400);
    expect(await linesNamed(`M4 refund ${c.fx.tag}`)).toBe(0);
  }, 120000);

  // brk-nrfa round 10 K1/K2: the remedy match stamps the line's pointer at the re-reversal R2. Both arms and the 428
  // read the movement from its chain's root, so the next real sweep posts and a typed copy still answers 428.
  const bankReverseAndReReverse = async (line: string) => {
    const j1 = String((await lineState(line))!.ptr);
    expect((await callRoute(c.fx, token, bankTxAction, { action: 'reverse', bankTransactionId: line })).statusCode).toBe(200);
    const r1 = String(((await sql`SELECT id FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID
      AND reversal_of_id = ${j1}::UUID`) as Row[])[0]!.id);
    return { j1, r2: await glReverse(r1) };
  };
  it('a pointer at a live re-reversal is read from the chain root (sweep posts; typed copy answers 428)', async () => {
    const aMon = await bankLine(bankA, '2028-11-06', -4100, 'K1 OUT MON');
    await bankLine(bankB, '2028-11-06', 4100, 'K1 IN MON');
    expect((await allocTransfer(aMon, bankB)).statusCode).toBe(200);
    const { r2 } = await bankReverseAndReReverse(aMon);
    expect((await confirm(aMon, await lineOf(r2, bankA))).statusCode).toBe(200);
    await bankLine(bankA, '2028-11-07', -4100, 'K1 OUT TUE');
    expect((await allocTransfer(await bankLine(bankB, '2028-11-07', 4100, 'K1 IN TUE'), bankA)).statusCode).toBe(200);
    expect(await glMovement(bankB, '2028-11-06', '2028-11-30')).toBe(8200);

    for (const [date, amt, toRoot] of [['2028-12-04', 4200, false], ['2028-12-11', 4300, true]] as const) {
      const a = await bankLine(bankA, date, -amt, `K2 OUT ${date}`);
      expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
      const { j1, r2: rr } = await bankReverseAndReReverse(a);
      expect((await confirm(a, await lineOf(toRoot ? j1 : rr, bankA))).statusCode).toBe(200);
      expect((await typed(amt, date)).statusCode).toBe(428);
      expect(await glMovement(bankB, date, date)).toBe(amt);
    }
  }, 180000);

  // brk-nrfa round 10 L2: arm 2 looks as far as pairing does (ten days), so a typed transfer's statement line clearing
  // on D+6 and ALLOCATED (not matched) is refused, not posted a second time.
  it('a typed transfer is found within ten days of its statement line', async () => {
    expect((await typed(3300, '2029-01-08')).statusCode).toBe(200);
    expect((await allocTransfer(await bankLine(bankB, '2029-01-14', 3300, 'P1 IN D+6'), bankA)).statusCode).toBe(400);
    expect(await glMovement(bankB, '2029-01-01', '2029-01-31')).toBe(3300);
  }, 120000);

  // brk-nrfa round 10 L4: a transfer with no contra (the body's own shape: 422), another company's contra or a non-bank
  // contra (400) is an answer the person can act on, with nothing written.
  it('the manual route answers a transfer with no contra 422, and a foreign or non-bank contra 400', async () => {
    const foreign = String(((await sql`SELECT id FROM gl_accounts WHERE company_id <> ${c.fx.companyId}::UUID
      AND account_subtype = 'bank' LIMIT 1`) as Row[])[0]?.id ?? '00000000-0000-4000-8000-000000000001');
    for (const [d, contra, status] of [['X1 nocontra', undefined, 422], ['X2 foreign', foreign, 400],
      ['X3 nonbank', c.expense, 400]] as const) {
      const r = await manual({ type: 'spend', bankAccountId: bankA, date: '2029-02-05', amount: 180,
        description: `${d} ${c.fx.tag}`, allocationType: 'transfer', ...(contra ? { contraAccountId: contra } : {}) });
      expect(r.statusCode, `${d} ${JSON.stringify(r.body)}`).toBe(status);
      expect(await linesNamed(`${d} ${c.fx.tag}`)).toBe(0);
    }
  }, 120000);

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
});
