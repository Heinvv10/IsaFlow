/**
 * DOCNUM (brk-docnum R2-F3): the bank-import rule pass and a journal number held past its 5 s bound.
 *
 * `bank-transactions-bulk-commit` imports a statement and then runs the rule pass (`applyRules`), which posts each
 * matching line in its own savepoint. Since migration 858 a line's journal number waits on the company+year number
 * lock, bounded at 5 s, and a peer holding it longer fails the line with a raw 55P03. The pass re-threw it (it is not
 * one of the typed contention events), and bulk-commit's catch swallowed the throw: the route answered 200 with
 * `appliedRules: 0` while withAuth COMMITted every rule line posted before it. Now the held line is skipped and
 * counted in `autoPostSkippedLocked` (the pass's existing held counter, in the response), the other lines post, and
 * `appliedRules` is exactly what was posted.
 *
 * NUMRACE (2026-10-06): a request whose import and rule pass span two years takes both years' keys before the
 * import (bank/bulkCommitRulePass), so with one of them held it fails retryable and writes nothing; the per-line
 * skip is kept for a single-year pass.
 *
 * Driven through the real route the way withAuth runs it: one transaction, COMMIT below 500.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import { cleanupK074, seedK074, type K074Fixture } from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => null) }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'docnum_bank_rules' });
let fx: K074Fixture;

beforeAll(async () => {
  fx = await seedK074(pool);
  await pool.query(
    `INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
     VALUES($1,'DOCNUM FY2025 P05',5,2025,'2025-05-01','2025-05-31','open')`, [fx.company]);
  const expense = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
     VALUES($1,$2,'DOCNUMX','DOCNUM expense','expense','other','debit',true)`, [expense, fx.company]);
  await pool.query(
    `INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,gl_account_id,
       priority,auto_create_entry,vat_code)
     VALUES($1,'DOCNUM rule','description','contains','DOCNUMFEE',$2,1,true,'none')`, [fx.company, expense]);
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [fx.company]);
    await pool.query('UPDATE bank_transactions SET import_batch_id = NULL WHERE company_id=$1', [fx.company])
      .catch(() => undefined);
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM bank_import_batches WHERE company_id=$1', [fx.company]).catch(() => undefined);
    await cleanupK074(pool, fx);
  } finally { await pool.end(); }
}, 60000);

async function bulkCommit(csvContent: string) {
  const { als } = await import('@/lib/als');
  const handler = (await import('../../pages/api/accounting/bank-transactions-bulk-commit')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
      await handler({
        method: 'POST', query: {}, companyId: fx.company, user: { id: fx.user },
        body: {
          bankAccountId: fx.bankAccount, bulkImportId: crypto.randomUUID(), bulkSequence: 1,
          filename: 'docnum.csv', fileType: 'csv', statementDate: '2026-05-31', csvContent,
          bankFormat: 'generic', applyBankRules: true,
        },
      } as unknown as NextApiRequest, result.res);
    });
    await client.query(result.state.statusCode < 500 ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    // A throw is a 5xx under withErrorHandler (mocked away here): withAuth rolls back.
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
  return { status: result.state.statusCode, body: result.state.body as Record<string, unknown> };
}

async function heldRun(csv: string, heldYear: number) {
  // A peer holds this company's number key for that year (the journal key of 857) for the whole request.
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 857))', [`${fx.company}:${heldYear}`]);
    return await bulkCommit(csv);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
}

async function linesLike(prefix: string) {
  return (await pool.query(
    `SELECT description, matched_journal_line_id IS NOT NULL AS posted FROM bank_transactions
     WHERE company_id=$1 AND description LIKE $2 ORDER BY description`, [fx.company, `${prefix}%`])).rows as
    { description: string; posted: boolean }[];
}

it('single-year pass: a rule line whose journal number is held past 5 s is skipped and counted', async () => {
  const csv = ['Date,Description,Amount', '2026-05-12,DOCNUMFEE S1,-50.00', '2026-05-13,DOCNUMFEE S2,-40.00'].join('\n');
  const out = await heldRun(csv, 2026);
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  const data = (out.body.data ?? out.body) as Record<string, unknown>;
  expect((await linesLike('DOCNUMFEE S')).map((l) => [l.description, l.posted]))
    .toEqual([['DOCNUMFEE S1', false], ['DOCNUMFEE S2', false]]);
  expect(data.appliedRules, 'appliedRules must be what was posted').toBe(0);
  expect(data.autoPostSkippedLocked).toBe(2);
}, 60000);

it('cross-year statement with one year held: the request fails retryable (55P03 -> 503) before anything is written', async () => {
  // NUMRACE round 2 (brk-numrace M1): the route takes every year the import sweep and the rule pass can post in
  // BEFORE the import, so a held year fails the whole request — nothing imported, nothing posted, PAYG refunded —
  // where round 1 landed the import and skipped the pass. withErrorHandler answers the 55P03 503 + Retry-After.
  const csv = ['Date,Description,Amount', '2025-05-10,DOCNUMFEE A,-100.00', '2026-05-12,DOCNUMFEE B,-50.00'].join('\n');
  const err = await heldRun(csv, 2026).then(() => null, (e: unknown) => e as { code?: string });
  expect(err?.code).toBe('55P03');
  const { isHeldRowError } = await import('@/lib/lockTimeout');
  expect(isHeldRowError(err)).toBe(true);
  expect((await linesLike('DOCNUMFEE ')).filter((l) => !l.description.startsWith('DOCNUMFEE S'))).toEqual([]);
}, 60000);
