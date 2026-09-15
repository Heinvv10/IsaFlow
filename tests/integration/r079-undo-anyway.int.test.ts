/**
 * R-079 round 2 — "Not the correction — undo anyway" (review MEDIUM-2).
 *
 * Detection fails closed, so an unrelated journal a person posted on one of
 * the posting's accounts blocks the undo. The reviewer's case: a later manual
 * Dr bank 25 / Cr E2 25 (a supplier refund entered by hand) blocked the undo
 * of an unrelated R100 posting, and the only ways out were to reverse a
 * legitimate entry or to "confirm" a correction that never happened. The user
 * now declares the journal unrelated: `audit_log` records who, when, the line
 * and the journal, and the line is undone normally.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupR079, fullReclass, nets, postJournal, postViaRoute, seedAutoPostedLine, seedR079, type R079Fixture,
} from './helpers/r079Fixture';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'r079_undo_anyway_int' });
let fx: R079Fixture;

beforeAll(async () => { fx = await seedR079(pool); });
afterAll(async () => {
  try { await cleanupR079(pool, fx); } finally { await pool.end(); }
});

const undo = (runId: string) => postViaRoute(pool, fx, { action: 'undo', runId });
const decide = (action: string, runId: string, transactionId: string, offsetJournalId: string) =>
  postViaRoute(pool, fx, { action, runId, transactionId, offsetJournalId });
const delta = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, b[k]! - a[k]!]));

async function contrasOf(je: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id=$1 AND company_id=$2', [je, fx.company]);
  return rows[0].n;
}
async function decisions(line: string): Promise<Array<{ user_id: string; reason: string; journal: string }>> {
  const { rows } = await pool.query(
    `SELECT user_id, changes->'metadata'->>'reason' AS reason, changes->'metadata'->>'offsetJournalId' AS journal
       FROM audit_log WHERE company_id=$1 AND entity_id=$2 ORDER BY created_at`, [fx.company, line]);
  return rows;
}
const refund25 = (f: R079Fixture) => [
  { glAccountId: f.bankAccount, debit: 25, credit: 0 }, { glAccountId: f.e2, debit: 0, credit: 25 },
];

it("the reviewer's case: an unrelated refund blocks, can't be marked the correction, and undo-anyway reverses the posting", async () => {
  const base = await nets(pool, fx);
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const refund = await postJournal(pool, fx, refund25(fx));

  const blocked = await undo(runId);
  expect(blocked.body.data).toMatchObject({
    reversed: 0, undone: false, skippedBy: { offsetByHand: 1 }, handOffsets: [{ journalEntryId: refund.id }],
  });
  // "Mark as corrected" is refused by the net check: E1 60 and E2 15 would stay charged.
  const marked = await decide('confirmHandCorrection', runId, line, refund.id);
  expect(marked.status).toBe(400);
  expect(marked.body.error?.message).toMatch(/cannot be recorded as the whole correction/);

  const res = await decide('undoAnyway', runId, line, refund.id);

  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({
    transactionId: line, offsetJournalId: refund.id, outcome: 'reversed', handOffset: null, runClosed: true,
  });
  // The posting is gone; the refund stands on its own: e1 0, e2 −25, bank +25.
  expect(delta(base, await nets(pool, fx))).toEqual({ e1: 0, e2: -25, e3: 0, bank: 25 });
  expect(await contrasOf(je)).toBe(1);
  expect(await decisions(line)).toEqual([
    { user_id: fx.user, reason: 'auto_post_offset_declared_unrelated', journal: refund.id },
  ]);
  const { rows: tx } = await pool.query(
    'SELECT status, provisional_je_id, auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
  expect(tx[0]).toEqual({ status: 'imported', provisional_je_id: null, auto_post_run_id: null });
}, 60000);

it('with two blocking journals, declaring one unrelated names the other; declaring both undoes the line', async () => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const first = await postJournal(pool, fx, refund25(fx));
  const second = await postJournal(pool, fx, [
    { glAccountId: fx.e1, debit: 0, credit: 10 }, { glAccountId: fx.e3, debit: 10, credit: 0 },
  ]);

  const one = await decide('undoAnyway', runId, line, first.id);

  expect(one.body.data).toMatchObject({ outcome: 'offsetByHand', runClosed: false, handOffset: { journalEntryId: second.id } });
  expect(await contrasOf(je)).toBe(0);
  // The first declaration stands, so a plain undo is now blocked only by the second.
  expect((await undo(runId)).body.data).toMatchObject({ handOffsets: [{ journalEntryId: second.id }] });

  const two = await decide('undoAnyway', runId, line, second.id);

  expect(two.body.data).toMatchObject({ outcome: 'reversed', runClosed: true });
  expect(await contrasOf(je)).toBe(1);
  expect((await decisions(line)).map((d) => d.journal)).toEqual([first.id, second.id]);
}, 60000);

it('a journal declared unrelated to a line can no longer be marked as its correction', async () => {
  const { line, runId } = await seedAutoPostedLine(pool, fx);
  const reclass = await postJournal(pool, fx, fullReclass(fx));
  const other = await postJournal(pool, fx, refund25(fx));
  // Declared unrelated; the refund still blocks, so the line stays in the run.
  expect((await decide('undoAnyway', runId, line, reclass.id)).body.data).toMatchObject({ outcome: 'offsetByHand' });

  const res = await decide('confirmHandCorrection', runId, line, reclass.id);

  expect(res.status).toBe(400);
  expect(res.body.error?.message).toMatch(/declared unrelated to this line/);
  expect((await decisions(line)).map((d) => d.journal)).toEqual([reclass.id]);
  expect(other.id).toBeTruthy();
}, 60000);

it('refuses to undo anyway over a journal that is not blocking the line, and writes nothing', async () => {
  const base = await nets(pool, fx);
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  // Moves only the bank back: it never blocks, so there is nothing to declare.
  const receipt = await postJournal(pool, fx, [
    { glAccountId: fx.bankAccount, debit: 25, credit: 0 }, { glAccountId: fx.e3, debit: 0, credit: 25 },
  ]);
  const before = delta(base, await nets(pool, fx));

  const res = await decide('undoAnyway', runId, line, receipt.id);

  expect(res.status).toBe(400);
  expect(res.body.error?.message).toMatch(/not blocking the undo of this line/);
  expect(await contrasOf(je)).toBe(0);
  expect(await decisions(line)).toEqual([]);
  expect(delta(base, await nets(pool, fx))).toEqual(before);
}, 60000);

it('refuses, with nothing recorded, when the reversal itself is refused (a closed period)', async () => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const refund = await postJournal(pool, fx, refund25(fx));
  await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1", [fx.company]);
  try {
    const res = await decide('undoAnyway', runId, line, refund.id);

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/could not be reversed .* nothing was recorded/);
    expect(await contrasOf(je)).toBe(0);
    expect(await decisions(line)).toEqual([]);
    const { rows } = await pool.query('SELECT auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
    expect(String(rows[0].auto_post_run_id)).toBe(runId);
  } finally {
    await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1", [fx.company]);
  }
}, 60000);

/**
 * Races. Both decisions and the undo lock the bank line first, so whichever
 * comes second finds it out of the run. Hold the line, queue both, let go.
 */
async function race(line: string, requests: () => Array<Promise<unknown>>): Promise<void> {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM bank_transactions WHERE id=$1 FOR UPDATE', [line]);
  const racing = Promise.allSettled(requests());
  await new Promise((r) => setTimeout(r, 300));
  await holder.query('COMMIT');
  holder.release();
  await racing;
}

it.each([
  ['undo-anyway vs undo', (runId: string, line: string, j: string) => [decide('undoAnyway', runId, line, j), undo(runId)]],
  ['undo-anyway vs undo-anyway', (runId: string, line: string, j: string) =>
    [decide('undoAnyway', runId, line, j), decide('undoAnyway', runId, line, j)]],
] as const)('%s reverses the posting exactly once', async (_name, requests) => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const refund = await postJournal(pool, fx, refund25(fx));

  await race(line, () => [...requests(runId, line, refund.id)]);

  expect(await contrasOf(je)).toBe(1);
  expect(await decisions(line)).toHaveLength(1);
}, 60000);

it('undo-anyway vs mark-corrected on the same line applies exactly one decision', async () => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  // A full reclass: both decisions would accept it on their own.
  const reclass = await postJournal(pool, fx, fullReclass(fx));

  await race(line, () => [
    decide('undoAnyway', runId, line, reclass.id), decide('confirmHandCorrection', runId, line, reclass.id),
  ]);

  const recorded = await decisions(line);
  expect(recorded).toHaveLength(1);
  // Undo-anyway reversed the posting, or mark-corrected left it standing — never both.
  expect(await contrasOf(je)).toBe(recorded[0]!.reason === 'auto_post_offset_declared_unrelated' ? 1 : 0);
}, 60000);
