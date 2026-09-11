/**
 * R-079 round 3 — reverse the blocking journal first (review r2 MEDIUM-1), and
 * undo-anyway never records a decision over a line it did not undo (LOW-2).
 *
 * Two ordinary corrections fail the net rule for "mark as corrected": a
 * reclass of a VAT-bearing posting that leaves the VAT alone, and a correction
 * split over two journals. Undo-anyway on either is R-079's double correction
 * (e1 −86.96 / e3 +86.96; e1 −60 / e2 −40 / e3 +100). The answer for that
 * shape is to reverse the journal first: once it is reversed through the
 * product, the chain walk sees it off the books and the undo nets to zero.
 * Undo-anyway stays available, behind the projected balances it would leave.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupR079, inRequest, netsWithVat, postJournal, postViaRoute, seedAutoPostedLine, seedR079, type R079Fixture,
} from './helpers/r079Fixture';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'r079_reverse_first_int' });
let fx: R079Fixture;

beforeAll(async () => { fx = await seedR079(pool); });
afterAll(async () => {
  try { await cleanupR079(pool, fx); } finally { await pool.end(); }
});

const undo = (runId: string) => postViaRoute(pool, fx, { action: 'undo', runId });
const decide = (action: string, runId: string, transactionId: string, offsetJournalId: string) =>
  postViaRoute(pool, fx, { action, runId, transactionId, offsetJournalId });
const delta = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, Math.round((b[k]! - a[k]!) * 100) / 100]));
const ZERO = { e1: 0, e2: 0, e3: 0, bank: 0, vat: 0 };
const r2 = (n: number) => Math.round(n * 100) / 100;

async function contrasOf(je: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id=$1 AND company_id=$2', [je, fx.company]);
  return rows[0].n;
}
async function auditRows(line: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM audit_log WHERE company_id=$1 AND entity_id=$2', [fx.company, line]);
  return rows[0].n;
}
async function reverse(journalId: string): Promise<void> {
  const { reverseJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryService');
  await inRequest(pool, fx, () => reverseJournalEntry(fx.company, journalId, fx.user));
}
/** The provisional shape for a `standard` prediction: net + VAT / bank. */
const vatPosting = (f: R079Fixture) => [
  { glAccountId: f.e1, debit: 86.96, credit: 0 }, { glAccountId: f.vat, debit: 13.04, credit: 0 },
  { glAccountId: f.bankAccount, debit: 0, credit: 100 },
];
const vatReclass = (f: R079Fixture) => [
  { glAccountId: f.e1, debit: 0, credit: 86.96 }, { glAccountId: f.e3, debit: 86.96, credit: 0 },
];

it('a VAT-bearing posting reclassed by hand: the notice says reverse it first, and doing so undoes to zero', async () => {
  const base = await netsWithVat(pool, fx);
  const { line, je, runId } = await seedAutoPostedLine(pool, fx, vatPosting(fx));
  const reclass = await postJournal(pool, fx, vatReclass(fx));

  const refused = await undo(runId);

  expect(refused.body.data).toMatchObject({
    undone: false, skippedBy: { offsetByHand: 1 },
    handOffsets: [{
      journalEntryId: reclass.id, netsPostingOut: false, reclass: true,
      // The double correction, before anyone confirms: E1 goes to −86.96.
      // Real balances: the fixture's earlier tests are in `base`.
      projection: [
        { accountName: 'K074 Bank', now: r2(base.bank! - 100), afterUndo: r2(base.bank!) },
        { accountCode: 'R79E1', now: r2(base.e1!), afterUndo: r2(base.e1! - 86.96) },
        { accountCode: 'R79E3', now: r2(base.e3! + 86.96), afterUndo: r2(base.e3! + 86.96) },
        { accountCode: 'R79VAT', now: r2(base.vat! + 13.04), afterUndo: r2(base.vat!) },
      ],
    }],
  });
  const marked = await decide('confirmHandCorrection', runId, line, reclass.id);
  expect(marked.status).toBe(400);
  expect(marked.body.error?.message).toMatch(/cannot be recorded as the whole correction.*Reverse that journal first/);

  await reverse(reclass.id);
  const res = await undo(runId);

  expect(res.body.data).toMatchObject({ reversed: 1, skipped: 0, undone: true, handOffsets: [] });
  expect(await contrasOf(je)).toBe(1);
  expect(delta(base, await netsWithVat(pool, fx))).toEqual(ZERO);
}, 60000);

it('the projection is what undo-anyway actually leaves', async () => {
  const base = await netsWithVat(pool, fx);
  const { line, runId } = await seedAutoPostedLine(pool, fx, vatPosting(fx));
  const reclass = await postJournal(pool, fx, vatReclass(fx));
  const projected = ((await undo(runId)).body.data!.handOffsets as Array<{ projection: Array<{ accountCode: string; afterUndo: number }> }>)[0]!.projection;

  expect((await decide('undoAnyway', runId, line, reclass.id)).body.data).toMatchObject({ outcome: 'reversed' });

  const abs = await netsWithVat(pool, fx);
  const byCode = Object.fromEntries(projected.map((p) => [p.accountCode, r2(p.afterUndo)]));
  expect({ e1: r2(abs.e1!), e3: r2(abs.e3!), vat: r2(abs.vat!) }).toEqual({ e1: byCode.R79E1, e3: byCode.R79E3, vat: byCode.R79VAT });
  expect(delta(base, abs)).toEqual({ e1: -86.96, e2: 0, e3: 86.96, bank: 0, vat: 0 });
}, 60000);

/**
 * Review r3 MEDIUM-1. With two journals on the posting's accounts, a
 * posting-plus-one-journal sum showed each dialog hiding one overstatement
 * (J2's read "E1 60 → 0" while the ledger went 0 → −60). Balances now, and
 * balances minus the posting after, tell the truth in both dialogs.
 */
it('a correction split over two journals: BOTH undo-anyway dialogs show the real balances', async () => {
  const base = await netsWithVat(pool, fx);
  const { line, runId } = await seedAutoPostedLine(pool, fx);
  const j1 = await postJournal(pool, fx, [{ glAccountId: fx.e1, debit: 0, credit: 60 }, { glAccountId: fx.e3, debit: 60, credit: 0 }]);
  const j2 = await postJournal(pool, fx, [{ glAccountId: fx.e2, debit: 0, credit: 40 }, { glAccountId: fx.e3, debit: 40, credit: 0 }]);
  // A DRAFT on E1 is not on the books and must not be in either column.
  await postJournal(pool, fx, [{ glAccountId: fx.e1, debit: 500, credit: 0 }, { glAccountId: fx.e3, debit: 0, credit: 500 }], { draft: true });
  type Proj = Array<{ accountCode: string; now: number; afterUndo: number }>;
  const rel = (p: Proj) => Object.fromEntries(p.map((x) => [x.accountCode, {
    now: r2(x.now - (base as Record<string, number>)[{ R79E1: 'e1', R79E2: 'e2', R79E3: 'e3' }[x.accountCode] ?? 'bank']!),
    after: r2(x.afterUndo - (base as Record<string, number>)[{ R79E1: 'e1', R79E2: 'e2', R79E3: 'e3' }[x.accountCode] ?? 'bank']!),
  }]));

  // J1's dialog. E1 and E2 are both at 0 now; after the undo E1 −60 AND E2 −40.
  const d1 = rel(((await undo(runId)).body.data!.handOffsets as Array<{ journalEntryId: string; projection: Proj }>)[0]!.projection);
  expect(d1.R79E1).toEqual({ now: 0, after: -60 });
  expect(d1.R79E2).toEqual({ now: 0, after: -40 });
  expect(d1.R79E3).toEqual({ now: 100, after: 100 });
  // Declare J1 unrelated; J2's dialog must say the same about E1, not "60 → 0".
  const second = (await decide('undoAnyway', runId, line, j1.id)).body.data as { outcome: string; handOffset: { journalEntryId: string; projection: Proj } };
  expect(second.outcome).toBe('offsetByHand');
  expect(second.handOffset.journalEntryId).toBe(j2.id);
  const d2 = rel(second.handOffset.projection);
  expect(d2.R79E1).toEqual({ now: 0, after: -60 });
  expect(d2.R79E2).toEqual({ now: 0, after: -40 });
  // And that is what undo-anyway on J2 leaves.
  expect((await decide('undoAnyway', runId, line, j2.id)).body.data).toMatchObject({ outcome: 'reversed' });
  expect(delta(base, await netsWithVat(pool, fx))).toEqual({ e1: -60, e2: -40, e3: 100, bank: 0, vat: 0 });
}, 60000);

it('a correction split over two journals: reverse each first, then the undo nets to zero', async () => {
  const base = await netsWithVat(pool, fx);
  const { je, runId } = await seedAutoPostedLine(pool, fx);
  const j1 = await postJournal(pool, fx, [{ glAccountId: fx.e1, debit: 0, credit: 60 }, { glAccountId: fx.e3, debit: 60, credit: 0 }]);
  const j2 = await postJournal(pool, fx, [{ glAccountId: fx.e2, debit: 0, credit: 40 }, { glAccountId: fx.e3, debit: 40, credit: 0 }]);

  expect((await undo(runId)).body.data).toMatchObject({ handOffsets: [{ journalEntryId: j1.id, netsPostingOut: false, reclass: true }] });
  await reverse(j1.id);
  expect((await undo(runId)).body.data).toMatchObject({ handOffsets: [{ journalEntryId: j2.id, netsPostingOut: false, reclass: true }] });
  await reverse(j2.id);
  expect((await undo(runId)).body.data).toMatchObject({ reversed: 1, undone: true });

  expect(await contrasOf(je)).toBe(1);
  expect(delta(base, await netsWithVat(pool, fx))).toEqual(ZERO);
}, 60000);

/** Review r2 LOW-2: an outcome that is not an undo must not record a declaration or drop the line. */
it('refuses undo-anyway on a line reconciled after the refusal: no audit row, no contra, line kept', async () => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const blocker = await postJournal(pool, fx, vatReclass(fx));
  await undo(runId);
  await pool.query("UPDATE bank_transactions SET status='reconciled' WHERE id=$1", [line]);

  const res = await decide('undoAnyway', runId, line, blocker.id);

  expect(res.status).toBe(400);
  expect(res.body.error?.message).toMatch(/reconciled — unreconcile it first/);
  expect(await auditRows(line)).toBe(0);
  expect(await contrasOf(je)).toBe(0);
  const { rows } = await pool.query('SELECT status, auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
  expect(rows[0]).toEqual({ status: 'reconciled', auto_post_run_id: runId });
}, 60000);

it('refuses undo-anyway when the posting was re-reversed by hand meanwhile: no audit row', async () => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const blocker = await postJournal(pool, fx, vatReclass(fx));
  await undo(runId);
  // Reverse the posting, then reverse that reversal: the posting is back on the books.
  await reverse(je);
  const { rows: contra } = await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id=$1', [je]);
  await reverse(String(contra[0].id));

  const res = await decide('undoAnyway', runId, line, blocker.id);

  expect(res.status).toBe(400);
  expect(res.body.error?.message).toMatch(/cannot be undone as it stands/);
  expect(await auditRows(line)).toBe(0);
  const { rows } = await pool.query('SELECT auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
  expect(String(rows[0].auto_post_run_id)).toBe(runId);
}, 60000);
