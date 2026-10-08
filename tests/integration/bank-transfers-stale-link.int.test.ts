/**
 * Bank transfers (PR #670, brk-nrfa round 5): a bank line's `transfer_journal_entry_id` survives an unmatch, so a line
 * stranded on a transfer journal and then matched elsewhere still points at it. Neither duplicate guard
 * (bank/transferDuplicateGuard) nor the board pack's line evidence (reports/unusualJournalsService) may read that
 * pointer as a match; and a re-reversal of a statement transfer is judged by the root of its reversal chain.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { sql } from '@/lib/neon';
import bankTxAction from '../../pages/api/accounting/bank-transactions-action';
import bankMatchConfirm from '../../pages/api/accounting/bank-match-confirm';
import bankTransfers from '../../pages/api/accounting/bank-transfers';
import bankTxManual from '../../pages/api/accounting/bank-transactions-manual';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getUnusualJournals } from '@/modules/accounting/services/reports/unusualJournalsService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
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
const flags = async (start: string, end: string) => (await getUnusualJournals(c.fx.companyId, { start, end })).flags
  .filter((f) => f.reason === 'round_number').map((f) => ({ n: f.entryNumber, amt: f.amount }));
const lineState = async (id: string) => ((await sql`SELECT status, matched_journal_line_id AS m,
  transfer_journal_entry_id AS ptr FROM bank_transactions WHERE id = ${id}::UUID`) as Row[])[0];
/** A posted journal DR `dr` / CR `cr`, through the funnel (source as given: 'manual' for an unrelated entry). */
const journal = async (date: string, dr: string, cr: string, amount: number, source: string, reference?: string) =>
  inTx(c.fx, async () => {
    const je = await createJournalEntry(c.fx.companyId, { entryDate: date, description: `STALE ${source}`,
      source: source as never, ...(reference ? { reference } : {}), lines: [
        { glAccountId: dr, debit: amount, credit: 0, description: 'dr' },
        { glAccountId: cr, debit: 0, credit: amount, description: 'cr' }] } as never, c.fx.userId);
    await postJournalEntry(c.fx.companyId, je.id, c.fx.userId);
    return String(je.id);
  });

describeIfDb('a transfer pointer left behind by an unmatch is not evidence', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('STALE', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'stale');
    bankA = c.fx.bankAccountId;
    const mk = async (code: string, name: string) => String(((await sql`INSERT INTO gl_accounts (company_id,
      account_code, account_name, account_type, account_subtype, normal_balance, is_active) VALUES
      (${c.fx.companyId}::UUID, ${code}, ${name}, 'asset', 'bank', 'debit', true) RETURNING id`) as Row[])[0]!.id);
    bankB = await mk('1010', 'STALE Savings');
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID`;
    await dropRouteUser(c.fx);
    await dropFixture(c.fx);
  }, 60000);

  /** A line linked to journal `j`'s leg on `bank` (bank-match-confirm's transfer arm), unmatched — the pointer stays —
   * then matched to its own journal: live again, its transfer pointer still at `j`. */
  const strandOn = async (line: string, j: string, bank: string, own: string) => {
    expect((await callRoute(c.fx, token, bankMatchConfirm,
      { bankTransactionId: line, candidateType: 'bank_transfer', candidateId: await lineOf(j, bank) })).statusCode).toBe(200);
    expect((await callRoute(c.fx, token, bankTxAction, { action: 'unmatch', bankTransactionId: line })).statusCode).toBe(200);
    expect((await callRoute(c.fx, token, bankTxAction,
      { action: 'match', bankTransactionId: line, journalLineId: await lineOf(own, bank) })).statusCode).toBe(200);
    const s = await lineState(line);
    expect([s!.status, s!.ptr]).toEqual(['matched', j]);
  };

  // brk-nrfa round 5 F1, arm 1: the B line allocated as the transfer from A (J1); an A debit order stranded on J1;
  // the REAL A leg allocated as the transfer to B must be refused — J1 already holds that movement.
  it('arm 1: a stranded pointer does not pair the counterparty transfer', async () => {
    const bLine = await bankLine(bankB, '2026-07-02', 3200, 'S1m TRANSFER IN');
    expect((await allocTransfer(bLine, bankA)).statusCode).toBe(200);
    const j1 = String((await transferJournals('2026-07-02', '2026-07-02'))[0]!.id);
    const aWrong = await bankLine(bankA, '2026-07-02', -3200, 'S1m DEBIT ORDER');
    await strandOn(aWrong, j1, bankA, await journal('2026-07-02', c.expense, bankA, 3200, 'manual'));
    const aReal = await bankLine(bankA, '2026-07-03', -3200, 'S1m TRANSFER OUT');
    expect((await allocTransfer(aReal, bankB)).statusCode).toBe(400);
    expect(await glMovement(bankB, '2026-07-02', '2026-07-03')).toBe(3200);
  }, 60000);

  // F1, arm 2: a typed A -> B journal; an unrelated B receipt stranded on it; the real B line must be refused.
  it('arm 2: a stranded pointer does not consume a typed transfer', async () => {
    const j1 = await journal('2026-07-13', bankB, bankA, 4000, 'auto_bank_transfer', 'Transfer: A -> B');
    const bWrong = await bankLine(bankB, '2026-07-13', 4000, 'S2 CUSTOMER RECEIPT');
    await strandOn(bWrong, j1, bankB, await journal('2026-07-13', bankB, c.expense, 4000, 'manual'));
    const bReal = await bankLine(bankB, '2026-07-14', 4000, 'S2 TRANSFER IN');
    expect((await allocTransfer(bReal, bankA)).statusCode).toBe(400);
    expect(await glMovement(bankB, '2026-07-10', '2026-07-17')).toBe(8000); // the transfer and the receipt, once each
  }, 60000);

  // F3: the board pack's evidence for a typed journal must not read the stranded pointer.
  it('board pack: a stranded pointer does not back a typed round number', async () => {
    const j1 = await journal('2026-09-07', bankB, bankA, 50000, 'auto_bank_transfer', 'Transfer: A -> B');
    const n1 = String(((await sql`SELECT entry_number FROM gl_journal_entries WHERE id = ${j1}::UUID`) as Row[])[0]!.entry_number);
    expect((await flags('2026-09-01', '2026-09-30')).map((f) => f.n)).toContain(n1);
    const bWrong = await bankLine(bankB, '2026-09-07', 50000, 'S3 CUSTOMER RECEIPT');
    await strandOn(bWrong, j1, bankB, await journal('2026-09-07', bankB, c.expense, 50000, 'manual'));
    expect((await flags('2026-09-01', '2026-09-30')).map((f) => f.n)).toContain(n1);
  }, 60000);

  // F4: a statement transfer reversed from the bank (J2), then J2 reversed in the GL (J3): J3 re-posts the statement's
  // amount, a document's, so no transfer journal of the month is flagged.
  it('board pack: a re-reversal of a statement transfer is judged by the chain root', async () => {
    const a = await bankLine(bankA, '2026-08-03', -60000, 'S4 OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    expect((await callRoute(c.fx, token, bankTxAction, { action: 'reverse', bankTransactionId: a })).statusCode).toBe(200);
    const j2 = (await transferJournals('2026-08-01', '2026-08-31')).find((j) => j.reversal_of_id !== null)!;
    await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, String(j2.id), c.fx.userId));
    const journals = await transferJournals('2026-08-01', '2026-08-31');
    expect(journals).toHaveLength(3);
    const numbers = journals.map((j) => String(j.entry_number));
    expect((await flags('2026-08-01', '2026-08-31')).filter((f) => numbers.includes(String(f.n)))).toEqual([]);
  }, 60000);

  // The Transfers page's 428 lookup reads the same evidence: a statement journal whose own line no longer matches it
  // (simulated) and a B line stranded on it is not "recorded from the statement" — the typed post goes through.
  it('428 lookup: a stranded pointer does not make a statement journal current', async () => {
    const a = await bankLine(bankA, '2026-10-05', -2600, 'S5 OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    const j1 = String((await lineState(a))!.ptr);
    await sql`UPDATE bank_transactions SET status = 'imported', matched_journal_line_id = NULL WHERE id = ${a}::UUID`;
    const bWrong = await bankLine(bankB, '2026-10-05', 2600, 'S5 CUSTOMER RECEIPT');
    await strandOn(bWrong, j1, bankB, await journal('2026-10-05', bankB, c.expense, 2600, 'manual'));
    const typed = await callRoute(c.fx, token, bankTransfers,
      { fromAccountId: bankA, toAccountId: bankB, amount: 2600, transferDate: '2026-10-06' });
    expect(typed.statusCode, JSON.stringify(typed.body)).toBe(200);
  }, 60000);

  // sec-nrfa round 5 L1: "already paired" means a line matched to its own bank's leg for its amount, not any line
  // matched to any leg. An unrelated charge matched to the typed journal's OTHER leg, or a fee to the free leg of a
  // statement transfer, must not let the real line post the movement a second time.
  it('arm 2: a charge matched to the other leg does not consume a typed transfer', async () => {
    const t = await journal('2026-11-04', bankB, bankA, 5000, 'auto_bank_transfer', 'Transfer: A -> B');
    const real = await bankLine(bankB, '2026-11-04', 5000, 'L1 TRANSFER IN');
    expect((await allocTransfer(real, bankA)).statusCode).toBe(400);
    const junk = await bankLine(bankB, '2026-11-05', -12, 'L1 BANK CHARGE');
    expect((await callRoute(c.fx, token, bankMatchConfirm,
      { bankTransactionId: junk, candidateType: 'bank_transfer', candidateId: await lineOf(t, bankA) })).statusCode).toBe(200);
    expect((await allocTransfer(real, bankA)).statusCode).toBe(400);
    expect(await glMovement(bankB, '2026-11-01', '2026-11-10')).toBe(5000);
  }, 60000);

  it('arm 1: a fee matched to the free leg does not pair a statement transfer', async () => {
    const a = await bankLine(bankA, '2026-12-05', -7000, 'L1 TRANSFER OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    const s = String((await lineState(a))!.ptr);
    const real = await bankLine(bankB, '2026-12-06', 7000, 'L1 TRANSFER IN');
    expect((await allocTransfer(real, bankA)).statusCode).toBe(400);
    const junk = await bankLine(bankB, '2026-12-06', -15, 'L1 FEE');
    expect((await callRoute(c.fx, token, bankMatchConfirm,
      { bankTransactionId: junk, candidateType: 'bank_transfer', candidateId: await lineOf(s, bankB) })).statusCode).toBe(200);
    expect((await allocTransfer(real, bankA)).statusCode).toBe(400);
    expect(await glMovement(bankB, '2026-12-01', '2026-12-10')).toBe(7000);
  }, 60000);

  // brk-nrfa round 6 M1: a transfer keyed by hand through Receive Money on B (its journal auto-links A's imported
  // line) is not B's statement line: when that arrives and is allocated as the transfer from A, it is refused.
  it('a hand-keyed line on this bank does not pair the transfer for the statement line', async () => {
    const aLine = await bankLine(bankA, '2027-01-04', -1500, 'H1 TRANSFER OUT');
    expect((await callRoute(c.fx, token, bankTxManual, { type: 'receive', bankAccountId: bankB, date: '2027-01-04',
      amount: 1500, description: `H1 hk ${c.fx.tag}`, allocationType: 'transfer', contraAccountId: bankA })).statusCode).toBe(201);
    expect((await lineState(aLine))!.status).not.toBe('imported'); // the auto-link took A's statement line
    const bLine = await bankLine(bankB, '2027-01-04', 1500, 'H1 TRANSFER IN');
    expect((await allocTransfer(bLine, bankA)).statusCode).toBe(400);
    expect(await glMovement(bankB, '2027-01-01', '2027-01-08')).toBe(1500);
    expect(await glMovement(bankA, '2027-01-01', '2027-01-08')).toBe(-1500);
  }, 60000);

  // brk-nrfa round 6 L1: once both legs of a statement transfer are reversed from the bank, the movement can be
  // allocated again — a reversed journal holds nothing, and a dead line pairs nothing.
  it('both legs of a reversed transfer can be allocated again', async () => {
    const aLine = await bankLine(bankA, '2027-02-22', -2300, 'H2b OUT');
    const bLine = await bankLine(bankB, '2027-02-22', 2300, 'H2b IN');
    expect((await allocTransfer(aLine, bankB)).statusCode).toBe(200);
    for (const id of [aLine, bLine]) {
      expect((await callRoute(c.fx, token, bankTxAction, { action: 'reverse', bankTransactionId: id })).statusCode).toBe(200);
    }
    expect(await glMovement(bankB, '2027-02-20', '2027-02-28')).toBe(0);
    const again = await allocTransfer(aLine, bankB);
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect(await glMovement(bankB, '2027-02-20', '2027-02-28')).toBe(2300);
  }, 60000);

  // brk-nrfa round 6 L1: a transfer journal reversed in the GL leaves its statement line allocated and matched to it;
  // the other bank's line of that movement is not refused against a journal that no longer holds it.
  it('a transfer reversed in the GL does not refuse the other leg', async () => {
    const aLine = await bankLine(bankA, '2027-03-10', -2400, 'GLREV OUT');
    expect((await allocTransfer(aLine, bankB)).statusCode).toBe(200);
    const j1 = String((await lineState(aLine))!.ptr);
    expect((await callRoute(c.fx, token, journalEntriesAction, { id: j1, action: 'reverse' })).statusCode).toBe(200);
    expect((await lineState(aLine))!.status).toBe('allocated'); // still matched to the reversed journal
    const bLine = await bankLine(bankB, '2027-03-11', 2400, 'GLREV IN');
    const b = await allocTransfer(bLine, bankA);
    expect(b.statusCode, JSON.stringify(b.body)).toBe(200);
  }, 60000);

  // sec-nrfa round 6 M1: a transfer reversed in the GL and the reversal reversed is back on the books — its chain of
  // posted reversals is even — though the original still reads reversed_at (journalReversalState).
  const glReverse = async (je: string) => {
    const r = await callRoute(c.fx, token, journalEntriesAction, { id: je, action: 'reverse' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    return String((r.body as { data: { id: string } }).data.id);
  };
  it('a re-reversed transfer holds the movement: arm 1, arm 2 and the 428', async () => {
    const a = await bankLine(bankA, '2027-04-08', -4200, 'RR1 OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    await glReverse(await glReverse(String((await lineState(a))!.ptr)));
    expect((await allocTransfer(await bankLine(bankB, '2027-04-09', 4200, 'RR1 IN'), bankA)).statusCode).toBe(400);

    const t = await journal('2027-05-06', bankB, bankA, 5300, 'auto_bank_transfer', 'Transfer: A -> B');
    await glReverse(await glReverse(t));
    expect((await allocTransfer(await bankLine(bankB, '2027-05-07', 5300, 'RR2 IN'), bankA)).statusCode).toBe(400);

    const a3 = await bankLine(bankA, '2027-06-10', -6400, 'RR3 OUT');
    expect((await allocTransfer(a3, bankB)).statusCode).toBe(200);
    await glReverse(await glReverse(String((await lineState(a3))!.ptr)));
    expect((await callRoute(c.fx, token, bankTransfers,
      { fromAccountId: bankA, toAccountId: bankB, amount: 6400, transferDate: '2027-06-11' })).statusCode).toBe(428);
  }, 90000);

  // sec-nrfa round 6 L1: a line that pairs the journal is of the same movement — within five days of it. A May
  // receipt of the amount matched to an October transfer's leg does not let October's real line post it again.
  it('a far-dated line matched to the leg does not pair the transfer', async () => {
    const a = await bankLine(bankA, '2027-10-12', -8800, 'RR5 OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    const j1 = String((await lineState(a))!.ptr);
    const real = await bankLine(bankB, '2027-10-13', 8800, 'RR5 TRANSFER IN');
    expect((await allocTransfer(real, bankA)).statusCode).toBe(400);
    const receipt = await bankLine(bankB, '2027-05-04', 8800, 'RR5 CUSTOMER RECEIPT');
    expect((await callRoute(c.fx, token, bankMatchConfirm,
      { bankTransactionId: receipt, candidateType: 'bank_transfer', candidateId: await lineOf(j1, bankB) })).statusCode).toBe(200);
    expect((await allocTransfer(real, bankA)).statusCode).toBe(400);
    expect(await glMovement(bankA, '2027-10-01', '2027-10-31')).toBe(-8800);
    // Arm 2, the same: a typed November transfer, a May receipt matched to its B leg, then November's real line.
    const t = await journal('2027-11-15', bankB, bankA, 9100, 'auto_bank_transfer', 'Transfer: A -> B');
    const may = await bankLine(bankB, '2027-05-06', 9100, 'RR5 MAY RECEIPT');
    expect((await callRoute(c.fx, token, bankMatchConfirm,
      { bankTransactionId: may, candidateType: 'bank_transfer', candidateId: await lineOf(t, bankB) })).statusCode).toBe(200);
    expect((await allocTransfer(await bankLine(bankB, '2027-11-16', 9100, 'RR5 NOV IN'), bankA)).statusCode).toBe(400);
  }, 90000);
});
