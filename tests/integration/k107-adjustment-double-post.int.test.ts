/**
 * K-107 round 6, census survivor HIGH-2b — `adjustmentService.approveAdjustment`.
 *
 * It read `adjRows[0].status !== 'draft'` in JS and then posted to AR or AP,
 * finishing with an UPDATE that carried no status predicate and whose row count
 * was discarded — while `cancelAdjustment`, eleven lines below in the same
 * file, has always been predicated. Two concurrent approvals moved the
 * customer's or supplier's control account twice for one adjustment.
 *
 * The final UPDATE also ran on a SECOND connection (`withTransaction`), which
 * could not see the claim taken on the request's own; it is now on the request
 * transaction with everything else.
 *
 * Proved by OUTCOME — the AR account's movement — under two interleaved pool
 * clients AND two sequential attempts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  AdjustmentNotApprovableError,
  approveAdjustment,
} from '../../src/modules/accounting/services/items/adjustmentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const arAccount = crypto.randomUUID(), incomeAccount = crypto.randomUUID(), expenseAccount = crypto.randomUUID();

const HOLD_MS = 300;

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(ctxFor(client), fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** One draft customer DEBIT adjustment of 500.00 — DR AR / CR other income. */
async function seedAdjustment(companyId = company): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO accounting_adjustments(id,company_id,adjustment_number,entity_type,entity_id,
                                        adjustment_type,amount,reason,adjustment_date,status,created_by)
     VALUES($1,$2,$3,'customer',$4,'debit',500,'rebate reversal','2026-04-01','draft',$5)`,
    [id, companyId, `K107R6-ADJ-${id.slice(0, 8)}`, customer, user]);
  return id;
}

/** What the AR control account actually moved, measured off posted lines. */
async function arDebited(): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(jl.debit),0) AS d FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id=$1 AND je.status='posted' AND jl.gl_account_id=$2`, [company, arAccount]);
  return Number(r.rows[0].d);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R6 adjustment fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K107 R6 customer']);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,
                             is_system_account,is_active)
     VALUES($1,$2,'1200','Accounts Receivable','asset','receivable','debit',true,true),
            ($3,$2,'8000','Other Income','revenue','other_income','credit',true,true),
            ($4,$2,'6100','Admin Expense','expense','admin_expense','debit',true,true)`,
    [arAccount, company, incomeAccount, expenseAccount]);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE accounting_adjustments SET gl_journal_entry_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM accounting_adjustments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('debits AR ONCE when two requests approve the same adjustment simultaneously', async () => {
  const adj = await seedAdjustment();
  const before = await arDebited();
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await als.run(ctxFor(a), () => approveAdjustment(company, adj, user));

    let settled = false;
    const attempt = als.run(ctxFor(b), () => approveAdjustment(company, adj, user));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const loser = await attempt.then(() => null, (err: unknown) => err);
    await b.query('ROLLBACK');

    expect.soft(loser).toBeInstanceOf(AdjustmentNotApprovableError);
    expect.soft((loser as AdjustmentNotApprovableError).adjustmentStatus).toBe('approved');
  } finally {
    a.release(); b.release();
  }

  expect.soft(await arDebited() - before).toBeCloseTo(500, 2);
  const row = await pool.query('SELECT status, gl_journal_entry_id, approved_by FROM accounting_adjustments WHERE id=$1', [adj]);
  expect.soft(row.rows[0].status).toBe('approved');
  expect.soft(String(row.rows[0].approved_by)).toBe(user);
  expect(row.rows[0].gl_journal_entry_id).not.toBeNull();
});

it('refuses the SEQUENTIAL double-click, posting nothing the second time', async () => {
  const adj = await seedAdjustment();
  const before = await arDebited();
  await inTx(() => approveAdjustment(company, adj, user));

  const second = await inTx(() => approveAdjustment(company, adj, user))
    .then(() => null, (err: unknown) => err);
  expect.soft(second).toBeInstanceOf(AdjustmentNotApprovableError);
  expect.soft((second as AdjustmentNotApprovableError).adjustmentStatus).toBe('approved');

  expect(await arDebited() - before).toBeCloseTo(500, 2);
});

it('posts a balanced journal agreeing with the adjustment amount on the legitimate path', async () => {
  const adj = await seedAdjustment();
  await inTx(() => approveAdjustment(company, adj, user));

  const je = await pool.query(
    `SELECT je.id, je.status, je.fiscal_period_id, je.entry_date,
            COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM gl_journal_entries je
       JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
       JOIN accounting_adjustments a ON a.gl_journal_entry_id = je.id
      WHERE a.id = $1
      GROUP BY je.id, je.status, je.fiscal_period_id, je.entry_date`, [adj]);
  expect.soft(je.rowCount).toBe(1);
  expect.soft(je.rows[0].status).toBe('posted');
  expect.soft(je.rows[0].fiscal_period_id).not.toBeNull();
  // fmtDate, not a UTC slice: the adjustment_date must not roll back a day.
  expect.soft(String(je.rows[0].entry_date).slice(0, 10)).toBe('2026-04-01');
  expect.soft(Number(je.rows[0].dr)).toBeCloseTo(500, 2);
  expect(Number(je.rows[0].cr)).toBeCloseTo(500, 2);
});

it('refuses an adjustment that is already cancelled, before it posts anything', async () => {
  const adj = await seedAdjustment();
  await pool.query("UPDATE accounting_adjustments SET status='cancelled' WHERE id=$1", [adj]);
  const before = await arDebited();

  const err = await inTx(() => approveAdjustment(company, adj, user)).then(() => null, (e: unknown) => e);
  expect.soft(err).toBeInstanceOf(AdjustmentNotApprovableError);
  expect.soft((err as AdjustmentNotApprovableError).adjustmentStatus).toBe('cancelled');
  expect(await arDebited()).toBeCloseTo(before, 2);
});

it('will not approve an adjustment belonging to another tenant', async () => {
  const otherCompany = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K107 R6 adjustment other']);
  const theirs = await seedAdjustment(otherCompany);

  const err = await inTx(() => approveAdjustment(company, theirs, user)).then(() => null, (e: unknown) => e);
  expect.soft((err as Error).message).toMatch(/Adjustment not found/);
  const still = await pool.query('SELECT status, gl_journal_entry_id FROM accounting_adjustments WHERE id=$1', [theirs]);
  expect.soft(still.rows[0].status).toBe('draft');
  expect(still.rows[0].gl_journal_entry_id).toBeNull();

  await pool.query('DELETE FROM accounting_adjustments WHERE company_id=$1', [otherCompany]);
  await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
});
