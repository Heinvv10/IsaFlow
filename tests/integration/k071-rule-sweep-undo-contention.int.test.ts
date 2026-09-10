/**
 * K-071 r15 — contention on the two routes the round-14 census never walked,
 * measured on real SQL.
 *
 * 1. `bank-rules-action` (apply) → `applyRules` → per-line savepoint →
 *    `autoPostRuleLine` → `recordSupplierBankPayment` → a held BILL. The
 *    `retryable` refusal surfaces through a savepoint that rolled back
 *    CLEANLY, so the request transaction is live. The sweep re-threw it; the
 *    route answered 400 "Action failed" and withAuth COMMITted the line the
 *    sweep had already posted. Now: 200, the held line counted in
 *    `autoPostSkippedLocked`, the posted line kept, and a later run posts it.
 * 2. `bank-auto-post` (undo) → `undoRun` → `reverseReconciledTransaction` → a
 *    held bank LINE, locked on the request transaction itself. `undoRun`
 *    swallowed the typed error on the aborted transaction, the next statement
 *    raised 25P02, and the route answered 400. Now: 409, and the line reversed
 *    before the held one is rolled back with it — the run stays undoable.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest } from 'next';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import {
  cleanupK074, seedBankLine, seedBill, seedK074, DAY, type K074Fixture,
} from './helpers/k074Fixture';

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'k071_r15_int' });
let fx: K074Fixture;
let expense: string;

beforeAll(async () => {
  fx = await seedK074(pool);
  await pool.query("UPDATE suppliers SET auto_allocate_strategy='oldest' WHERE id=$1", [fx.supplier]);
  expense = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
     VALUES($1,$2,'K71R15X','K071 r15 Expense','expense','other','debit',true)`,
    [expense, fx.company],
  );
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [fx.company]);
    await pool.query('UPDATE bank_transactions SET auto_post_run_id=NULL WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM bank_auto_post_runs WHERE company_id=$1', [fx.company]);
    await cleanupK074(pool, fx);
  } finally { await pool.end(); }
});

/** The route the way withAuth runs it: one transaction, COMMIT below 500. */
async function run(route: string, body: unknown) {
  const { als } = await import('@/lib/als');
  const handler = (await import(route)).default as (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: fx.user, companyId: fx.company, claims: {} }, async () => {
      await handler({ method: 'POST', body, query: {}, companyId: fx.company, user: { id: fx.user } } as unknown as NextApiRequest, result.res);
    });
    if (result.state.statusCode < 500) { await client.query('COMMIT'); committed = true; } else { await client.query('ROLLBACK'); }
  } finally { client.release(); }
  return { status: result.state.statusCode, body: result.state.body as Record<string, unknown>, committed };
}

async function holding<T>(lockSql: string, param: string, fn: () => Promise<T>): Promise<T> {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(lockSql, [param]);
    return await fn();
  } finally { await holder.query('ROLLBACK'); holder.release(); }
}

async function status(id: string): Promise<string> {
  const { rows } = await pool.query('SELECT status FROM bank_transactions WHERE id=$1', [id]);
  return String(rows[0].status);
}

const RULES = '../../pages/api/accounting/bank-rules-action';
const UNDO = '../../pages/api/accounting/bank-auto-post';
const ACTION = '../../pages/api/accounting/bank-transactions-action';

it('rule sweep: a held bill is skipped and counted; the rest of the run still posts', async () => {
  await seedBill(pool, fx, 1000);
  await pool.query(
    `INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,gl_account_id,priority,auto_create_entry,vat_code)
     VALUES($1,'K71R15 account rule','description','contains','K71R15A',$2,1,true,'none')`, [fx.company, expense]);
  await pool.query(
    `INSERT INTO bank_categorisation_rules(company_id,rule_name,match_field,match_type,match_pattern,supplier_id,priority,auto_create_entry,vat_code)
     VALUES($1,'K71R15 supplier rule','description','contains','K71R15B',$2,2,true,'none')`, [fx.company, fx.supplier]);
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
     VALUES($1,$3,$4,$5::DATE,-100,'K71R15A fee','imported'),($2,$3,$4,$5::DATE,-400,'K71R15B supplier','imported')`,
    [a, b, fx.company, fx.bankAccount, DAY]);

  const held = await holding('SELECT id FROM supplier_invoices WHERE company_id=$1 FOR UPDATE', fx.company,
    () => run(RULES, { action: 'apply', bankAccountId: fx.bankAccount }));

  // Was 400 "Action failed" with line A committed behind it.
  expect(held.status).toBe(200);
  const data = (held.body.data ?? held.body) as Record<string, unknown>;
  expect(data.autoPostSkippedLocked).toBe(1);
  expect(await status(a)).toBe('allocated');
  expect(await status(b)).toBe('imported');

  // Control: the same sweep with nobody holding the bill posts line B.
  const control = await run(RULES, { action: 'apply', bankAccountId: fx.bankAccount });
  expect(control.status).toBe(200);
  expect(await status(b)).toBe('allocated');
  await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id=$1', [fx.company]);
}, 60000);

it('undo: a held line answers 409 and rolls back the lines reversed before it', async () => {
  const lines = [await seedBankLine(pool, fx, -50), await seedBankLine(pool, fx, -70)];
  for (const id of lines) {
    const r = await run(ACTION, { action: 'allocate', bankTransactionId: id, allocationType: 'account', contraAccountId: expense });
    expect(r.status).toBe(200);
  }
  const { rows: runRows } = await pool.query(
    `INSERT INTO bank_auto_post_runs(company_id,source,min_confidence,amount_cap,posted_count,total_amount)
     VALUES($1,'categorization',0.9,1000,2,120) RETURNING id`, [fx.company]);
  const runId = String(runRows[0].id);
  await pool.query('UPDATE bank_transactions SET auto_post_run_id=$1 WHERE id=ANY($2::UUID[])', [runId, lines]);
  // Hold the line undoRun's own SELECT returns LAST, so one line is reversed
  // before the contention — the case that proves the rollback, not a no-op.
  const { rows: order } = await pool.query(
    'SELECT id FROM bank_transactions WHERE auto_post_run_id=$1 AND company_id=$2', [runId, fx.company]);
  const last = String(order[order.length - 1].id);

  const held = await holding('SELECT id FROM bank_transactions WHERE id=$1 FOR UPDATE', last,
    () => run(UNDO, { action: 'undo', runId }));

  // Was 400 "Undo failed" (a 25P02 from the swallowed 55P03).
  expect(held.status).toBe(409);
  expect(JSON.stringify(held.body)).toMatch(/retry in a moment/i);
  for (const id of lines) expect(await status(id)).toBe('allocated');
  const { rows: runAfter } = await pool.query('SELECT undone_at FROM bank_auto_post_runs WHERE id=$1', [runId]);
  expect(runAfter[0].undone_at).toBeNull();

  // Control: nobody holding — the same undo reverses both.
  const control = await run(UNDO, { action: 'undo', runId });
  expect(control.status).toBe(200);
  expect((control.body.data ?? control.body)).toMatchObject({ reversed: 2, skipped: 0 });
  for (const id of lines) expect(await status(id)).toBe('imported');
}, 60000);
