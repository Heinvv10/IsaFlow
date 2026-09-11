/**
 * R-079 — `undoRun` re-reversed an auto-posted journal the user had already
 * offset with a MANUAL journal. The offset carries no `reversal_of_id` and no
 * `reversed_at`, so the undo could not see it. Measured by the K-071 round-22
 * fixer: `{"afterHand":{"e1":0,"e2":40},"afterUndo":{"e1":-60,"e2":0},
 * "undone":true}` — E1 ends 60 out while the run reads undone.
 *
 * The undo now refuses such a row with `offsetByHand`, posts nothing for it,
 * keeps the run open with the tag intact, and names the journal. Every other
 * shape must behave exactly as before: an untouched posting is reversed, a
 * hand REVERSAL is `alreadyUndone`, and a manual journal on the same account
 * that does not correct THIS posting does not block the undo.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupR079, inRequest, measuredHandOffset, nets, postJournal, postViaRoute, seedAutoPostedLine, seedR079,
  type R079Fixture,
} from './helpers/r079Fixture';
import { DAY, seedBankLine } from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'r079_offset_int' });
let fx: R079Fixture;

beforeAll(async () => { fx = await seedR079(pool); });
afterAll(async () => {
  try { await cleanupR079(pool, fx); } finally { await pool.end(); }
});

const undo = (runId: string) => postViaRoute(pool, fx, { action: 'undo', runId });
const delta = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, b[k]! - a[k]!]));

async function contrasOf(je: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id=$1 AND company_id=$2', [je, fx.company]);
  return rows[0].n;
}

async function lineState(line: string) {
  const { rows } = await pool.query(
    'SELECT status, provisional_je_id, auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
  return rows[0];
}

it('refuses the measured hand offset: posts nothing, keeps the run open and names the journal', async () => {
  const base = await nets(pool, fx);
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const offset = await postJournal(pool, fx, measuredHandOffset(fx));
  const afterHand = delta(base, await nets(pool, fx));
  expect(afterHand).toEqual({ e1: 0, e2: 40, e3: 0, bank: -40 });

  const res = await undo(runId);

  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({
    reversed: 0, skipped: 1, alreadyUndone: 0, undone: false,
    skippedBy: { reconciled: 0, contended: 0, failed: 0, offsetByHand: 1 },
    handOffsets: [{
      transactionId: line, lineDate: DAY, lineAmount: -100, lineDescription: 'K074 payment',
      journalEntryId: offset.id, entryNumber: offset.entryNumber, entryDate: DAY, amount: 60, description: 'R079 journal',
      // Partial: E2 40 stays charged, so it cannot be "the correction" — reverse it first.
      netsPostingOut: false, reclass: false,
      projection: [
        { accountCode: expect.any(String), accountName: 'K074 Bank', now: -40, afterUndo: 60 },
        { accountCode: 'R79E1', accountName: 'R079 R79E1', now: 0, afterUndo: -60 },
        { accountCode: 'R79E2', accountName: 'R079 R79E2', now: 40, afterUndo: 0 },
      ],
    }],
  });
  // The money is exactly where the user's correction left it — not E1 −60.
  expect(delta(base, await nets(pool, fx))).toEqual(afterHand);
  expect(await contrasOf(je)).toBe(0);
  expect(await lineState(line)).toEqual({ status: 'provisional', provisional_je_id: je, auto_post_run_id: runId });
  const { rows: run } = await pool.query('SELECT undone_at FROM bank_auto_post_runs WHERE id=$1', [runId]);
  expect(run[0].undone_at).toBeNull();
}, 60000);

it('still reverses a posting nobody touched — exactly once, to zero', async () => {
  const base = await nets(pool, fx);
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);

  const res = await undo(runId);

  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ reversed: 1, skipped: 0, undone: true, handOffsets: [] });
  expect(delta(base, await nets(pool, fx))).toEqual({ e1: 0, e2: 0, e3: 0, bank: 0 });
  expect(await contrasOf(je)).toBe(1);
  expect(await lineState(line)).toEqual({ status: 'imported', provisional_je_id: null, auto_post_run_id: null });
}, 60000);

it('keeps K-071: a hand REVERSAL is alreadyUndone, not an offset', async () => {
  const { reverseJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryService');
  const base = await nets(pool, fx);
  const { je, runId } = await seedAutoPostedLine(pool, fx);
  await inRequest(pool, fx, () => reverseJournalEntry(fx.company, je, fx.user));

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 0, skipped: 0, alreadyUndone: 1, undone: true, handOffsets: [] });
  expect(delta(base, await nets(pool, fx))).toEqual({ e1: 0, e2: 0, e3: 0, bank: 0 });
  expect(await contrasOf(je)).toBe(1);
}, 60000);

/**
 * Detection fails closed (round 2): any journal a person posted after the
 * posting that moves one of its NON-bank accounts back blocks the undo — the
 * reclass is the common hand correction, and the ledger cannot tell it from
 * an unrelated journal on the same account. The user decides.
 */
it.each([
  ['a reclass that moves E1 to an account the posting never touched', {},
    (f: R079Fixture) => [{ glAccountId: f.e1, debit: 0, credit: 60 }, { glAccountId: f.e3, debit: 60, credit: 0 }]],
  ['a journal that moves E1 back by MORE than was posted', {},
    (f: R079Fixture) => [{ glAccountId: f.e1, debit: 0, credit: 80 }, { glAccountId: f.bankAccount, debit: 80, credit: 0 }]],
  ['a reclass between the posting\'s own accounts (E1 back, E2 forward)', {},
    (f: R079Fixture) => [{ glAccountId: f.e1, debit: 0, credit: 30 }, { glAccountId: f.e2, debit: 30, credit: 0 }]],
  // Round 4: a correction posted after the auto-posting but DATED before it
  // (month-end practice) blocks like any other — the bound is posting time.
  ['a person reclass posted later but DATED before the posting', { entryDate: '2026-05-10' },
    (f: R079Fixture) => [{ glAccountId: f.e1, debit: 0, credit: 60 }, { glAccountId: f.e3, debit: 60, credit: 0 }]],
  ['an unrelated refund entered by hand (Dr bank 25 / Cr E2 25)', {},
    (f: R079Fixture) => [{ glAccountId: f.bankAccount, debit: 25, credit: 0 }, { glAccountId: f.e2, debit: 0, credit: 25 }]],
] as const)('blocks the undo until the user decides: %s', async (_name, opts, lines) => {
  const base = await nets(pool, fx);
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const journal = await postJournal(pool, fx, [...lines(fx)], opts);
  const before = delta(base, await nets(pool, fx));

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({
    reversed: 0, undone: false, skippedBy: { offsetByHand: 1 },
    handOffsets: [{ transactionId: line, journalEntryId: journal.id }],
  });
  expect(await contrasOf(je)).toBe(0);
  expect(delta(base, await nets(pool, fx))).toEqual(before);
}, 60000);

/**
 * Guards fail both ways. None of these can be a person's correction of THIS
 * posting, so none may block: the run undoes and the journal stands alone.
 */
it.each([
  ['the offset shape dated BEFORE the posting', 'before', {},
    (f: R079Fixture) => measuredHandOffset(f)],
  ['a system journal of the offset shape', 'after', { source: 'auto_adjustment' },
    (f: R079Fixture) => measuredHandOffset(f)],
  ['a manual-source journal an MCP agent posted', 'after', { postingAgent: 'mcp:test-agent:v1' },
    (f: R079Fixture) => measuredHandOffset(f)],
  ['a later receipt that moves only the BANK back (Dr bank 25 / Cr E3 25)', 'after', {},
    (f: R079Fixture) => [{ glAccountId: f.bankAccount, debit: 25, credit: 0 }, { glAccountId: f.e3, debit: 0, credit: 25 }]],
  ['an accrual charging E1 the SAME way as the posting', 'after', {},
    (f: R079Fixture) => [{ glAccountId: f.e1, debit: 30, credit: 0 }, { glAccountId: f.apAccount, debit: 0, credit: 30 }]],
] as const)('does not block the undo: %s', async (_name, when, opts, lines) => {
  const base = await nets(pool, fx);
  let unrelated: { id: string } | null = null;
  if (when === 'before') unrelated = await postJournal(pool, fx, [...lines(fx)], opts);
  const { je, runId } = await seedAutoPostedLine(pool, fx);
  if (when === 'after') unrelated = await postJournal(pool, fx, [...lines(fx)], opts);
  const withUnrelated = delta(base, await nets(pool, fx));

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 1, skipped: 0, undone: true, handOffsets: [] });
  expect(await contrasOf(je)).toBe(1);
  const after = delta(base, await nets(pool, fx));
  expect(after).toEqual({
    e1: withUnrelated.e1! - 60, e2: withUnrelated.e2! - 40, e3: withUnrelated.e3!, bank: withUnrelated.bank! + 100,
  });
  expect(unrelated).not.toBeNull();
}, 60000);

it('does not block the undo: another bank line\'s allocation of the offset shape (a refund)', async () => {
  const { je, runId } = await seedAutoPostedLine(pool, fx);
  const refund = await postJournal(pool, fx, measuredHandOffset(fx));
  const refundLine = await seedBankLine(pool, fx, 60);
  await pool.query("UPDATE bank_transactions SET status='provisional', provisional_je_id=$1 WHERE id=$2", [refund.id, refundLine]);

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 1, skipped: 0, undone: true, handOffsets: [] });
  expect(await contrasOf(je)).toBe(1);
}, 60000);

it('does not block the undo: a hand offset the user has since reversed', async () => {
  const { reverseJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryService');
  const { je, runId } = await seedAutoPostedLine(pool, fx);
  const offset = await postJournal(pool, fx, measuredHandOffset(fx));
  await inRequest(pool, fx, () => reverseJournalEntry(fx.company, offset.id, fx.user));

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 1, skipped: 0, undone: true, handOffsets: [] });
  expect(await contrasOf(je)).toBe(1);
}, 60000);

it('does not block the undo: the reversal of an unrelated earlier journal', async () => {
  const { reverseJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryService');
  // Posted BEFORE the auto-posting, in the posting's own direction...
  const earlier = await postJournal(pool, fx, [
    { glAccountId: fx.e1, debit: 60, credit: 0 }, { glAccountId: fx.bankAccount, debit: 0, credit: 60 },
  ]);
  const { je, runId } = await seedAutoPostedLine(pool, fx);
  // ...and reversed AFTER it: the contra has the offset's shape and date, but
  // it corrects the earlier journal, which its reversal_of_id says.
  await inRequest(pool, fx, () => reverseJournalEntry(fx.company, earlier.id, fx.user));

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 1, skipped: 0, undone: true, handOffsets: [] });
  expect(await contrasOf(je)).toBe(1);
}, 60000);

it('refuses a journal LINKED to the bank line even when the system made it', async () => {
  const base = await nets(pool, fx);
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  // System-sourced, so only the LINK (it names the bank line as its source
  // record) makes it block.
  const linked = await postJournal(pool, fx, [
    { glAccountId: fx.e1, debit: 0, credit: 60 }, { glAccountId: fx.e3, debit: 60, credit: 0 },
  ], { source: 'auto_adjustment' });
  await pool.query('UPDATE gl_journal_entries SET source_record_id=$1 WHERE id=$2', [line, linked.id]);
  const afterHand = delta(base, await nets(pool, fx));

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({
    reversed: 0, undone: false, skippedBy: { offsetByHand: 1 },
    handOffsets: [{ transactionId: line, journalEntryId: linked.id, entryNumber: linked.entryNumber }],
  });
  expect(await contrasOf(je)).toBe(0);
  expect(delta(base, await nets(pool, fx))).toEqual(afterHand);
}, 60000);

it('does not block the undo: a LINKED journal that charges the posting\'s accounts the same way', async () => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  // E.g. a supplier invoice from the same captured document: linked, but it
  // moves nothing of the posting back, so it corrects nothing.
  const linked = await postJournal(pool, fx, [
    { glAccountId: fx.e1, debit: 60, credit: 0 }, { glAccountId: fx.apAccount, debit: 0, credit: 60 },
  ], { source: 'auto_adjustment' });
  await pool.query('UPDATE gl_journal_entries SET source_record_id=$1 WHERE id=$2', [line, linked.id]);

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 1, skipped: 0, undone: true, handOffsets: [] });
  expect(await contrasOf(je)).toBe(1);
}, 60000);

it('refuses a hand offset on the MATCHED path (a categorization allocation) too', async () => {
  const line = await seedBankLine(pool, fx, -100);
  const posting = await postJournal(pool, fx, [
    { glAccountId: fx.e1, debit: 60, credit: 0 }, { glAccountId: fx.e2, debit: 40, credit: 0 },
    { glAccountId: fx.bankAccount, debit: 0, credit: 100 },
  ], { source: 'auto_bank_recon' });
  const { rows: bankLeg } = await pool.query(
    'SELECT id FROM gl_journal_lines WHERE journal_entry_id=$1 AND gl_account_id=$2', [posting.id, fx.bankAccount]);
  const { rows: runRows } = await pool.query(
    `INSERT INTO bank_auto_post_runs(company_id,source,min_confidence,amount_cap,posted_count,total_amount)
     VALUES($1,'categorization',0.9,1000,1,100) RETURNING id`, [fx.company]);
  const runId = String(runRows[0].id);
  await pool.query(
    "UPDATE bank_transactions SET status='allocated', matched_journal_line_id=$1, auto_post_run_id=$2 WHERE id=$3",
    [bankLeg[0].id, runId, line]);
  const offset = await postJournal(pool, fx, measuredHandOffset(fx));

  const res = await undo(runId);

  expect(res.body.data).toMatchObject({
    reversed: 0, undone: false, skippedBy: { offsetByHand: 1 },
    handOffsets: [{ transactionId: line, journalEntryId: offset.id, entryNumber: offset.entryNumber }],
  });
  expect(await contrasOf(posting.id)).toBe(0);
  const { rows } = await pool.query('SELECT status, auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
  expect(rows[0]).toEqual({ status: 'allocated', auto_post_run_id: runId });
}, 60000);
