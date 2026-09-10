/**
 * K-071 r21 — an auto-posted line whose provisional JE the user already
 * reversed by hand, measured on real SQL.
 *
 * `undoRun` called `reverseJournalEntry` on it again, which refuses ("Journal
 * entry already reversed"). The refusal was counted as a skip, so every undo
 * answered `{reversed 0, skipped 1, undone false}` and the run could never
 * close — while the panel told the user to unreconcile a line that was not
 * reconciled. The journal already nets to zero: the undo now finishes the line
 * (back to `imported`, tag cleared) without posting, counts it as already
 * undone, and closes the run — with exactly ONE reversal of the journal.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedBankLine, seedK074, DAY, type K074Fixture } from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'k071_r21_int' });
let fx: K074Fixture;
let expense: string;

beforeAll(async () => {
  fx = await seedK074(pool);
  expense = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
     VALUES($1,$2,'K71R21X','K071 r21 Expense','expense','other','debit',true)`,
    [expense, fx.company],
  );
});
afterAll(async () => {
  try {
    await pool.query('UPDATE bank_transactions SET auto_post_run_id=NULL, provisional_je_id=NULL WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM bank_auto_post_runs WHERE company_id=$1', [fx.company]);
    await cleanupK074(pool, fx);
  } finally { await pool.end(); }
});

/** The route the way withAuth runs it: one transaction, COMMIT below 500. */
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const { als } = await import('@/lib/als');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

async function undoViaRoute(runId: string) {
  const handler = (await import('../../pages/api/accounting/bank-auto-post')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  await inRequest(() => handler(
    { method: 'POST', body: { action: 'undo', runId }, query: {}, companyId: fx.company, user: { id: fx.user } } as unknown as NextApiRequest,
    result.res,
  ));
  return { status: result.state.statusCode, body: result.state.body as { data?: Record<string, unknown> } };
}

it('finishes a line whose provisional JE was reversed by hand, closes the run, and never reverses twice', async () => {
  const { createJournalEntry, postJournalEntry, reverseJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryService');
  const line = await seedBankLine(pool, fx, -80);
  const je = await inRequest(async () => {
    const entry = await createJournalEntry(fx.company, {
      entryDate: DAY, description: 'K071 r21 provisional',
      lines: [
        { glAccountId: expense, debit: 80, credit: 0 },
        { glAccountId: fx.bankAccount, debit: 0, credit: 80 },
      ],
    }, fx.user);
    await postJournalEntry(fx.company, entry.id, fx.user);
    return entry.id;
  });
  const { rows: runRows } = await pool.query(
    `INSERT INTO bank_auto_post_runs(company_id,source,min_confidence,amount_cap,posted_count,total_amount)
     VALUES($1,'categorization',0.9,1000,1,80) RETURNING id`, [fx.company]);
  const runId = String(runRows[0].id);
  await pool.query(
    "UPDATE bank_transactions SET status='allocated', provisional_je_id=$1, auto_post_run_id=$2 WHERE id=$3",
    [je, runId, line]);

  // The user reverses the journal by hand.
  await inRequest(() => reverseJournalEntry(fx.company, je, fx.user));

  const undo = await undoViaRoute(runId);

  expect(undo.status).toBe(200);
  expect(undo.body.data).toEqual({
    reversed: 0, skipped: 0, skippedBy: { reconciled: 0, contended: 0, failed: 0 }, alreadyUndone: 1, undone: true,
  });
  const { rows: tx } = await pool.query(
    'SELECT status, provisional_je_id, auto_post_run_id FROM bank_transactions WHERE id=$1', [line]);
  expect(tx[0]).toEqual({ status: 'imported', provisional_je_id: null, auto_post_run_id: null });
  const { rows: run } = await pool.query('SELECT undone_at FROM bank_auto_post_runs WHERE id=$1', [runId]);
  expect(run[0].undone_at).not.toBeNull();
  // Exactly the one hand reversal — the undo posted nothing.
  const { rows: contras } = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id=$1 AND company_id=$2', [je, fx.company]);
  expect(contras[0].n).toBe(1);
}, 60000);

it('still reverses a provisional JE nobody reversed — exactly once', async () => {
  const { createJournalEntry, postJournalEntry } = await import('@/modules/accounting/services/gl/journalEntryService');
  const line = await seedBankLine(pool, fx, -90);
  const je = await inRequest(async () => {
    const entry = await createJournalEntry(fx.company, {
      entryDate: DAY, description: 'K071 r21 provisional, untouched',
      lines: [
        { glAccountId: expense, debit: 90, credit: 0 },
        { glAccountId: fx.bankAccount, debit: 0, credit: 90 },
      ],
    }, fx.user);
    await postJournalEntry(fx.company, entry.id, fx.user);
    return entry.id;
  });
  const { rows: runRows } = await pool.query(
    `INSERT INTO bank_auto_post_runs(company_id,source,min_confidence,amount_cap,posted_count,total_amount)
     VALUES($1,'categorization',0.9,1000,1,90) RETURNING id`, [fx.company]);
  const runId = String(runRows[0].id);
  await pool.query(
    "UPDATE bank_transactions SET status='allocated', provisional_je_id=$1, auto_post_run_id=$2 WHERE id=$3",
    [je, runId, line]);

  const undo = await undoViaRoute(runId);

  expect(undo.status).toBe(200);
  expect(undo.body.data).toMatchObject({ reversed: 1, skipped: 0, alreadyUndone: 0, undone: true });
  const { rows: contras } = await pool.query(
    'SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id=$1 AND company_id=$2', [je, fx.company]);
  expect(contras[0].n).toBe(1);
}, 60000);
