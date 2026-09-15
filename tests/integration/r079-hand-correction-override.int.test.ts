/**
 * R-079 — "mark as corrected by hand". After the undo refuses a row with
 * `offsetByHand`, a person may confirm that the journal IS the correction.
 * That closes the row WITHOUT posting anything, records who, when and which
 * journal in `audit_log`, and lets the run close. Round 2 decides it by the
 * NET (the K-071 principle): accepted only when a person made the journal and,
 * with the posting, it brings every non-bank account the posting charged back
 * to zero. Anything else is refused, so it cannot close a live posting.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  cleanupR079, fullReclass, measuredHandOffset, nets, postJournal, postViaRoute, seedAutoPostedLine, seedR079,
  type R079Fixture,
} from './helpers/r079Fixture';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'r079_override_int' });
let fx: R079Fixture;

beforeAll(async () => { fx = await seedR079(pool); });
afterAll(async () => {
  try { await cleanupR079(pool, fx); } finally { await pool.end(); }
});

const undo = (runId: string) => postViaRoute(pool, fx, { action: 'undo', runId });
const confirm = (runId: string, transactionId: string, offsetJournalId: string) =>
  postViaRoute(pool, fx, { action: 'confirmHandCorrection', runId, transactionId, offsetJournalId });

async function audits(line: string) {
  const { rows } = await pool.query(
    'SELECT user_id, action, entity_type, entity_ref, changes, created_at FROM audit_log WHERE company_id=$1 AND entity_id=$2',
    [fx.company, line]);
  return rows;
}
async function contrasOf(je: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id=$1 AND company_id=$2', [je, fx.company]);
  return rows[0].n;
}

it('closes a line a full reclass corrected: no net change, who/when/which journal recorded, run closed', async () => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const offset = await postJournal(pool, fx, fullReclass(fx));
  expect((await undo(runId)).body.data).toMatchObject({ undone: false, skippedBy: { offsetByHand: 1 } });
  const before = await nets(pool, fx);

  const res = await confirm(runId, line, offset.id);

  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({
    transactionId: line, offsetJournalId: offset.id, offsetEntryNumber: offset.entryNumber, runClosed: true,
  });
  expect(await nets(pool, fx)).toEqual(before);
  expect(await contrasOf(je)).toBe(0);
  // The line is still posted — as the user corrected it — and out of the run.
  const { rows: tx } = await pool.query(
    'SELECT status, provisional_je_id, auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
  expect(tx[0]).toEqual({ status: 'provisional', provisional_je_id: je, auto_post_run_id: null });
  const { rows: run } = await pool.query('SELECT undone_at, undone_by FROM bank_auto_post_runs WHERE id=$1', [runId]);
  expect(run[0].undone_at).not.toBeNull();
  expect(String(run[0].undone_by)).toBe(fx.user);
  const [audit, ...extra] = await audits(line);
  expect(extra).toHaveLength(0);
  expect(audit).toMatchObject({
    user_id: fx.user, action: 'update', entity_type: 'bank_transaction', entity_ref: offset.entryNumber,
    changes: {
      fields: [{ field: 'auto_post_run_id', old: runId, new: null, label: 'Auto-post run' }],
      metadata: {
        reason: 'auto_post_corrected_by_hand', runId, postingJournalId: je,
        offsetJournalId: offset.id, offsetEntryNumber: offset.entryNumber,
      },
    },
  });
  expect(audit.created_at).not.toBeNull();
  // And the undo cannot run again over it.
  expect((await undo(runId)).status).toBe(400);
}, 60000);

/**
 * Each journal below leaves the posting LIVE on at least one account, or was
 * not made by a person, so marking it "the correction" would close a run over
 * money still on the books. Every refusal is a 400 that writes nothing.
 */
const NOT_NET = /cannot be recorded as the whole correction/;
it.each([
  // Review MEDIUM-1, both measured shapes: accepted with the posting fully live.
  ['a manual Dr bank 1 / Cr E3 1', NOT_NET, async (f: R079Fixture) => (await postJournal(pool, f, [
    { glAccountId: f.bankAccount, debit: 1, credit: 0 }, { glAccountId: f.e3, debit: 0, credit: 1 },
  ])).id],
  ['a system receipt Dr bank 500 / Cr E3 500 (auto_payment)', NOT_NET, async (f: R079Fixture) => (await postJournal(pool, f, [
    { glAccountId: f.bankAccount, debit: 500, credit: 0 }, { glAccountId: f.e3, debit: 0, credit: 500 },
  ], { source: 'auto_payment' })).id],
  // The measured PARTIAL offset: E1 back to zero, E2 40 still charged.
  ['the measured partial offset (E1 only)', NOT_NET, async (f: R079Fixture) =>
    (await postJournal(pool, f, measuredHandOffset(f))).id],
  ['a full reclass an MCP agent posted', /Only a journal a person posted/, async (f: R079Fixture) =>
    (await postJournal(pool, f, fullReclass(f), { postingAgent: 'mcp:test-agent:v1' })).id],
  ['a full reclass from a system source', /Only a journal a person posted/, async (f: R079Fixture) =>
    (await postJournal(pool, f, fullReclass(f), { source: 'auto_adjustment' })).id],
  ['a journal on accounts the posting never touched', NOT_NET, async (f: R079Fixture) => (await postJournal(pool, f, [
    { glAccountId: f.e3, debit: 0, credit: 60 }, { glAccountId: f.apAccount, debit: 60, credit: 0 },
  ])).id],
  ['a journal that moves the accounts the SAME way as the posting', NOT_NET, async (f: R079Fixture) => (await postJournal(pool, f, [
    { glAccountId: f.e1, debit: 60, credit: 0 }, { glAccountId: f.bankAccount, debit: 0, credit: 60 },
  ])).id],
  ['a draft full reclass', NOT_NET, async (f: R079Fixture) =>
    (await postJournal(pool, f, fullReclass(f), { draft: true })).id],
  // The lines FK pins an account to its own company, so the lines carry this
  // company and only the ENTRY belongs to the other one: the entry's own
  // company is what the override must check.
  ['a full reclass whose entry is in ANOTHER company', NOT_NET, async (f: R079Fixture) => {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,source,status,created_by,posted_at)
       VALUES($1,$2,'2026-05-15','R079 other company','manual','posted',$3,NOW())`, [id, f.otherCompany, f.user]);
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
       VALUES($1,$2,$3,0,60),($1,$2,$4,0,40),($1,$2,$5,100,0)`, [id, f.company, f.e1, f.e2, f.e3]);
    return id;
  }],
  ['the posting itself', NOT_NET, async (_f: R079Fixture, je: string) => je],
] as const)('refuses to mark %s as the correction, and writes nothing', async (_name, message, make) => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx);
  const journalId = await make(fx, je);
  const before = await nets(pool, fx);

  const res = await confirm(runId, line, journalId);

  expect(res.status).toBe(400);
  expect(res.body.error?.message).toMatch(message);
  expect(await nets(pool, fx)).toEqual(before);
  const { rows: tx } = await pool.query('SELECT auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
  expect(String(tx[0].auto_post_run_id)).toBe(runId);
  expect(await audits(line)).toHaveLength(0);
  const { rows: run } = await pool.query('SELECT undone_at FROM bank_auto_post_runs WHERE id=$1', [runId]);
  expect(run[0].undone_at).toBeNull();
}, 60000);

it('leaves the run open while another line is still tagged; the confirmed journal then belongs to its line', async () => {
  const base = await nets(pool, fx);
  const first = await seedAutoPostedLine(pool, fx);
  const second = await seedAutoPostedLine(pool, fx);
  await pool.query('UPDATE bank_transactions SET auto_post_run_id=$1 WHERE id=$2', [first.runId, second.line]);
  // Posted after both postings, and it nets EITHER of them out.
  const offset = await postJournal(pool, fx, fullReclass(fx));

  const res = await confirm(first.runId, first.line, offset.id);

  expect(res.body.data).toMatchObject({ runClosed: false });
  const { rows: open } = await pool.query('SELECT undone_at FROM bank_auto_post_runs WHERE id=$1', [first.runId]);
  expect(open[0].undone_at).toBeNull();
  // One journal corrects one line: it cannot be confirmed for the second too...
  const again = await confirm(first.runId, second.line, offset.id);
  expect(again.status).toBe(400);
  expect(again.body.error?.message).toMatch(/already belongs to another bank line/);
  // ...and, now owned by the first line, it no longer blocks the second line's undo.
  expect((await undo(first.runId)).body.data).toMatchObject({ reversed: 1, skipped: 0, undone: true, handOffsets: [] });
  expect(await contrasOf(second.je)).toBe(1);
  expect(await contrasOf(first.je)).toBe(0);
  // Net: the first posting stands as the user corrected it (all on E3); the second is gone.
  const after = await nets(pool, fx);
  expect({ e1: after.e1! - base.e1!, e2: after.e2! - base.e2!, e3: after.e3! - base.e3!, bank: after.bank! - base.bank! })
    .toEqual({ e1: 0, e2: 0, e3: 100, bank: -100 });
}, 60000);

it('refuses a row that is not part of the run', async () => {
  const a = await seedAutoPostedLine(pool, fx);
  const b = await seedAutoPostedLine(pool, fx);
  const offset = await postJournal(pool, fx, measuredHandOffset(fx));

  const res = await confirm(a.runId, b.line, offset.id);

  expect(res.status).toBe(400);
  expect(res.body.error?.message).toMatch(/no longer part of this run/);
  expect(await audits(b.line)).toHaveLength(0);
}, 60000);

/**
 * Two undos racing on an untouched posting: the row lock serializes them, so
 * the journal is reversed exactly once whatever the order.
 */
it('two racing undos reverse the posting exactly once', async () => {
  const base = await nets(pool, fx);
  const { je, runId } = await seedAutoPostedLine(pool, fx);

  const results = await Promise.allSettled([undo(runId), undo(runId)]);

  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  expect(await contrasOf(je)).toBe(1);
  expect(await nets(pool, fx)).toEqual(base);
}, 60000);
