/**
 * Bank transfers (PR #670, brk-nrfa rounds 16-20, sec-nrfa rounds 16-19): the bank match screen's journal-line
 * candidates for a statement line — the transfer guard's remedy ("match the line to that journal") must be reachable, and
 * only the right transfer leg may be ranked as "the existing transfer". Split from bank-transfers-pairing (file size).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import bankTxAction from '../../pages/api/accounting/bank-transactions-action';
import bankMatchConfirm from '../../pages/api/accounting/bank-match-confirm';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { fetchJournalLineCandidates } from '@/modules/accounting/services/bank/bankMatchDbQueries';
import { callRoute, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let c: DateFixture;
let token = '';
let bankA = '';
let bankB = '';

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

describeIfDb('the match screen offers the transfer guard\'s remedy, and only the right transfer leg', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('MSCR', DATABASE_URL!);
    token = await seedRouteUser(c.fx, 'mscr');
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
  /** A posted manual journal DR `dr` / CR `cr` of `amount`, through the funnel. */
  const postJournal = (date: string, dr: string, cr: string, description: string, amount: number) => inTx(c.fx, async () => {
    const je = await createJournalEntry(c.fx.companyId, { entryDate: date, description, source: 'manual', lines: [
      { glAccountId: dr, debit: amount, credit: 0, description: 'dr' },
      { glAccountId: cr, debit: 0, credit: amount, description: 'cr' }] } as never, c.fx.userId);
    await postJournalEntry(c.fx.companyId, je.id, c.fx.userId);
    return String(je.id);
  });
  const glReverse = async (je: string) => {
    const r = await callRoute(c.fx, token, journalEntriesAction, { id: je, action: 'reverse' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    return String((r.body as { data: { id: string } }).data.id);
  };

  // brk-nrfa rounds 16-17: the residual's remedy is "match the statement line to the journal". The match screen keeps
  // the 20 unmatched posted lines nearest the amount; among many lines of that amount the statement line's OWN BANK
  // wins the tie — however old the journal (a cheque clearing weeks later), even when 25 ordinary lines of the amount
  // are dated nearer the statement line.
  it('the match screen offers a transfer journal\'s bank leg among many nearer same-amount lines', async () => {
    const prepaid = String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      normal_balance, is_active) VALUES (${c.fx.companyId}::UUID, '1400', 'PAIR Prepaid', 'asset', 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
    const post = (date: string, dr: string, cr: string, description: string) => inTx(c.fx, async () => {
      const je = await createJournalEntry(c.fx.companyId, { entryDate: date, description, source: 'manual', lines: [
        { glAccountId: dr, debit: 150, credit: 0, description: 'dr' },
        { glAccountId: cr, debit: 0, credit: 150, description: 'cr' }] } as never, c.fx.userId);
      await postJournalEntry(c.fx.companyId, je.id, c.fx.userId);
      return String(je.id);
    });
    const transfer = await post('2029-10-06', bankB, bankA, 'Transfer A -> B (Journal Entries)');
    for (let i = 0; i < 25; i++) await post('2029-11-03', prepaid, c.expense, `top-up ${i}`); // all nearer the line
    const offered = (await fetchJournalLineCandidates(c.fx.companyId, 150, '2029-11-03', 'REM2 B IN', bankB))
      .map((x) => x.id);
    expect(offered).toContain(await lineOf(transfer, bankB));
    // sec-nrfa round 16: a journal dated 'infinity' (forged: every writer refuses it) sorts last, not a failed query.
    // (The numbering trigger refuses it on INSERT; a forged row gets there by an UPDATE of a posted journal.)
    const inf = await post('2029-11-03', prepaid, c.expense, 'PAIR forged infinity');
    try {
      await sql`UPDATE gl_journal_entries SET entry_date = 'infinity' WHERE id = ${inf}::UUID`;
      const again = (await fetchJournalLineCandidates(c.fx.companyId, 150, '2029-11-03', 'REM2 B IN', bankB)).map((x) => x.id);
      expect(again).toContain(await lineOf(transfer, bankB));
    } finally {
      await sql`UPDATE gl_journal_entries SET entry_date = '2029-11-03' WHERE id = ${inf}::UUID`;
    }
  }, 300000);

  // brk-nrfa round 18 L1: the "existing bank transfer" bonus is for the same movement only (the guard's ten days). An
  // old unmatched transfer leg of the amount on this bank stays an ordinary candidate and does not outrank the line
  // that is; a transfer leg within ten days still gets it.
  it('only a transfer leg within ten days is ranked as the existing transfer', async () => {
    const a = await bankLine(bankA, '2030-03-02', -2500, 'RT OLD OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200); // B's March leg: never matched (no B line)
    const old = await lineOf(String((await lineState(a))!.ptr), bankB);
    const near = await inTx(c.fx, async () => {
      const je = await createJournalEntry(c.fx.companyId, { entryDate: '2030-09-14', description: 'Receipt from Acme',
        source: 'manual', lines: [{ glAccountId: bankB, debit: 2500, credit: 0, description: 'in' },
          { glAccountId: c.expense, debit: 0, credit: 2500, description: 'acme' }] } as never, c.fx.userId);
      await postJournalEntry(c.fx.companyId, je.id, c.fx.userId);
      return lineOf(String(je.id), bankB);
    });
    const ranked = (await fetchJournalLineCandidates(c.fx.companyId, 2500, '2030-09-15', 'ACME RECEIPT', bankB))
      .sort((x, y) => y.score - x.score);
    // (The receipt's own expense leg can rank first — the scoring's date+description bonus, older than this PR.)
    const rank = (id: string) => ranked.findIndex((x) => x.id === id);
    expect(rank(near)).toBeGreaterThanOrEqual(0);
    expect(rank(near)).toBeLessThan(rank(old));
    expect(ranked.find((x) => x.id === old)?.matchReason ?? '').not.toMatch(/existing bank transfer/);
    const b = await bankLine(bankA, '2030-09-20', -2600, 'RT NEAR OUT');
    expect((await allocTransfer(b, bankB)).statusCode).toBe(200);
    const nearLeg = await lineOf(String((await lineState(b))!.ptr), bankB);
    const top = (await fetchJournalLineCandidates(c.fx.companyId, 2600, '2030-09-22', 'TRANSFER IN', bankB))
      .sort((x, y) => y.score - x.score)[0]!;
    expect([top.id, top.matchReason]).toEqual([nearLeg, expect.stringMatching(/existing bank transfer/)]);
  }, 300000);

  // brk-nrfa round 19: past the guard's ten days nothing refuses a second posting, so a transfer leg up to 30 days off
  // is still named (a lower bonus, its own label) in the "Bank Transfers" group; older ones are ordinary journal lines;
  // a reversed transfer, or the reversal undoing one, is never offered as "the existing transfer".
  it('graded transfer bonus: named up to 30 days, ordinary after, never for a reversal', async () => {
    const leg = async (date: string, amount: number) => {
      const a = await bankLine(bankA, date, -amount, `GR OUT ${date}`);
      expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
      return { line: a, id: await lineOf(String((await lineState(a))!.ptr), bankB) };
    };
    const find = async (amount: number, date: string, id: string) =>
      (await fetchJournalLineCandidates(c.fx.companyId, amount, date, 'TRANSFER IN', bankB)).find((x) => x.id === id)!;
    const late = await leg('2031-01-05', 2710);
    const l12 = await find(2710, '2031-01-17', late.id);
    expect([l12.type, l12.matchReason]).toEqual(['bank_transfer', expect.stringMatching(/May be an existing bank transfer journal \(12 days apart\)/)]);
    const old = await leg('2031-02-01', 2720);
    const l40 = await find(2720, '2031-03-13', old.id);
    expect([l40.type, l40.matchReason ?? '']).toEqual(['journal_line', expect.not.stringMatching(/bank transfer/)]);
    const undone = await leg('2031-04-01', 2730);
    expect((await callRoute(c.fx, token, bankTxAction, { action: 'reverse', bankTransactionId: undone.line })).statusCode).toBe(200);
    const cands = await fetchJournalLineCandidates(c.fx.companyId, -2730, '2031-04-03', 'RECEIPT', bankB);
    const ofAmount = cands.filter((y) => Math.abs(Math.abs(y.amount) - 2730) < 0.01);
    expect(ofAmount.length).toBeGreaterThan(0); // the reversal's B leg (and the original's) are candidates
    for (const x of ofAmount) {
      expect([x.type, x.matchReason ?? '']).toEqual(['journal_line', expect.not.stringMatching(/bank transfer/)]);
    }
    const orig = await find(2730, '2031-04-03', undone.id);
    expect(orig === undefined || orig.type === 'journal_line').toBe(true);
  }, 300000);

  // brk-nrfa round 20 M1 (pre-existing): only the leg on the statement line's OWN bank can be "the existing transfer". A
  // receipt into B after a B -> A transfer must not be offered the transfer's A-side leg as its top match.
  it('the other bank\'s transfer leg is never "the existing transfer" for this bank\'s line', async () => {
    const bOut = await bankLine(bankB, '2032-01-05', -7000, 'OB B OUT');
    expect((await allocTransfer(bOut, bankA)).statusCode).toBe(200);
    const aLeg = await lineOf(String((await lineState(bOut))!.ptr), bankA);
    const cands = await fetchJournalLineCandidates(c.fx.companyId, 7000, '2032-01-08', 'ACME RECEIPT', bankB);
    const offered = cands.find((x) => x.id === aLeg);
    expect(offered === undefined || (offered.type === 'journal_line' && !/bank transfer/.test(offered.matchReason ?? ''))).toBe(true);
  }, 120000);

  // brk-nrfa round 20 L1 / sec-nrfa round 19 L1: a reversal three steps down a chain (O -> R1 -> RR -> R3) undoes the
  // movement; it is never offered as "the existing transfer".
  it('a reversal three steps down a chain is not "the existing transfer"', async () => {
    const a = await bankLine(bankA, '2032-02-03', -888, 'R3 OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    let je = String((await lineState(a))!.ptr);
    for (let i = 0; i < 2; i++) je = await glReverse(je);
    // A live re-reversal (depth 2) IS the movement again: its B leg keeps the bonus (rev-nrfa round 20 LOW-2).
    const rrDate = String(((await sql`SELECT entry_date::text AS d FROM gl_journal_entries WHERE id = ${je}::UUID`) as Row[])[0]!.d);
    const rrLeg = await lineOf(je, bankB);
    const rrCand = (await fetchJournalLineCandidates(c.fx.companyId, 888, rrDate, 'TRANSFER IN', bankB)).find((x) => x.id === rrLeg)!;
    expect([rrCand.type, rrCand.matchReason]).toEqual(['bank_transfer', expect.stringMatching(/Matches existing bank transfer journal/)]);
    je = await glReverse(je);
    const r3Leg = await lineOf(je, bankB);
    // The statement line is dated with R3 (a reversal may be dated today), so only the depth decides.
    const r3Date = String(((await sql`SELECT entry_date::text AS d FROM gl_journal_entries WHERE id = ${je}::UUID`) as Row[])[0]!.d);
    const cands = await fetchJournalLineCandidates(c.fx.companyId, -888, r3Date, 'PAYMENT OUT', bankB); // R3's B leg credits B
    const offered = cands.find((x) => x.id === r3Leg);
    expect(offered).toBeDefined(); // an exact-amount candidate: it is offered, just not as the existing transfer
    expect(offered === undefined || (offered.type === 'journal_line' && !/bank transfer/.test(offered.matchReason ?? ''))).toBe(true);
  }, 120000);

  // brk-nrfa round 21 M1 (pre-existing): only a line that can be this statement line's bank leg is a candidate — on its
  // own bank, in its direction (money in debits the bank, money out credits it). A Sales line of the amount is never offered for a payment.
  it('only lines on the statement line\'s own bank, in its direction, are candidates', async () => {
    const sales = String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      normal_balance, is_active) VALUES (${c.fx.companyId}::UUID, '4000', 'MSCR Sales', 'revenue', 'credit', true)
      RETURNING id`) as Row[])[0]!.id);
    const je = await postJournal('2032-03-03', c.expense, sales, 'Sale reclass', 9300);
    const salesLeg = await lineOf(je, sales);
    // A receipt INTO bank B of the amount: on this bank, but the opposite direction of a payment.
    const receiptLeg = await lineOf(await postJournal('2032-03-03', bankB, sales, 'Receipt', 9300), bankB);
    const cands = await fetchJournalLineCandidates(c.fx.companyId, -9300, '2032-03-04', 'PAYMENT', bankB);
    expect(cands.map((x) => x.id)).not.toContain(salesLeg);
    expect(cands.map((x) => x.id)).not.toContain(receiptLeg);
    expect(cands.every((x) => x.amount < 0)).toBe(true);
  }, 120000);

  // brk-nrfa round 21 L1: confirming a reversed journal's leg is a refusal the person can act on (400), not a 500.
  it('confirming a reversed transfer journal\'s leg answers 400, writing nothing', async () => {
    const a = await bankLine(bankA, '2032-04-06', -3900, 'RV OUT');
    expect((await allocTransfer(a, bankB)).statusCode).toBe(200);
    const j1 = String((await lineState(a))!.ptr);
    await glReverse(j1);
    const b = await bankLine(bankB, '2032-04-06', 3900, 'RV IN');
    const r = await confirm(b, await lineOf(j1, bankB));
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect((await lineState(b))!.status).toBe('imported');
  }, 120000);

  // brk-nrfa round 23 L1 (pre-existing): a bank-first provisional's journal is held by its own statement line through
  // provisional_je_id; its bank leg is never offered to another line (confirming it would be refused, 409).
  it('a provisional journal\'s bank leg is not offered to another line', async () => {
    const pj = await postJournal('2032-05-04', c.expense, bankA, 'Provisional Uber 980', 980);
    const own = await bankLine(bankA, '2032-05-04', -980, 'UBER TRIP own');
    await sql`UPDATE bank_transactions SET status = 'provisional', provisional_je_id = ${pj}::UUID
      WHERE id = ${own}::UUID AND company_id = ${c.fx.companyId}::UUID`;
    const cands = await fetchJournalLineCandidates(c.fx.companyId, -980, '2032-05-06', 'UBER TRIP second', bankA);
    expect(cands.map((x) => x.id)).not.toContain(await lineOf(pj, bankA));
  }, 120000);
});
