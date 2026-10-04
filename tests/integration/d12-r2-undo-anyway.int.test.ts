/**
 * D12 round 2 (brk-d12 B5, the undo-anyway arm): "Not the correction — undo anyway" on an auto-posted line that a
 * COMPLETED reconciliation holds is the shared refusal (`ReconciliationCompletedError`, 409 through
 * `respondToUnhandledError`), not the generic "unreconcile it first" 400 — and the declaration rolls back with it.
 * The line joins the completed session by hand (as the k064 files seed one): status `reconciled` + its id.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { undoAnyway } from '@/modules/accounting/services/bank/autoPostHandCorrection';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { DAY } from './helpers/k074Fixture';
import { cleanupR079, inRequest, postJournal, seedAutoPostedLine, seedR079, type R079Fixture } from './helpers/r079Fixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'd12_r2_undo_anyway_int' });
let fx: R079Fixture;

beforeAll(async () => { fx = await seedR079(pool); });
afterAll(async () => {
  try {
    await pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = $1', [fx.company]);
    await pool.query('DELETE FROM bank_reconciliations WHERE company_id = $1', [fx.company]);
    await cleanupR079(pool, fx);
  } finally { await pool.end(); }
});

it('undoAnyway on a line IN a completed reconciliation -> the shared refusal; no contra, no decision recorded', async () => {
  const { line, je, runId } = await seedAutoPostedLine(pool, fx, undefined, 'matched');
  const refund = await postJournal(pool, fx, [
    { glAccountId: fx.bankAccount, debit: 25, credit: 0 }, { glAccountId: fx.e2, debit: 0, credit: 25 },
  ]);
  const { rows: [rec] } = await pool.query(`INSERT INTO bank_reconciliations (company_id, bank_account_id, statement_date,
    status, started_by) VALUES ($1, $2, $3, 'completed', $4) RETURNING id`, [fx.company, fx.bankAccount, DAY, fx.user]);
  await pool.query("UPDATE bank_transactions SET status = 'reconciled', reconciliation_id = $1 WHERE id = $2", [rec.id, line]);

  let err: unknown = null;
  try { await inRequest(pool, fx, () => undoAnyway(fx.company, runId, line, refund.id, fx.user)); } catch (e) { err = e; }

  expect((err as { code?: string } | null)?.code, String(err)).toBe('RECONCILIATION_COMPLETED');
  expect((err as Error).message).toMatch(/is completed — reopen it first/);
  const contras = (await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = $1', [je])).rows[0].n;
  expect(contras).toBe(0);
  expect((await pool.query('SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1 AND entity_id = $2',
    [fx.company, line])).rows[0].n, 'the declaration rolled back').toBe(0);
  expect((await pool.query('SELECT status, reconciliation_id::TEXT AS rec FROM bank_transactions WHERE id = $1', [line])).rows[0])
    .toEqual({ status: 'reconciled', rec: rec.id });
}, 60000);
