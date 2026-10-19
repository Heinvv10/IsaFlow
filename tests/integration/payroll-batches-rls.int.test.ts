/**
 * Migration 897: payroll_batches under app_user is scoped to the ACTIVE company.
 *
 * 498 left payroll_batches with membership-only USING and WITH CHECK, so a user
 * who belongs to companies A and B, working in A, could read, update, delete,
 * insert into and re-home B's batches through app_user. Each `two-company member`
 * case below passes on 498's policy and fails without 897's. The forged-GUC
 * cases (a member of A only, with app.current_company_id set to B) already held
 * on 498 and must keep holding. The service cases run payrollBatchService's
 * whole lifecycle the way withAuth does, so the narrowing breaks no real path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  addBatchLines, cancelBatch, createBatch, deleteBatch, getBatch, listBatches, postBatch, validateBatch,
} from '../../src/modules/accounting/services/payroll/payrollBatchService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const bothUser = crypto.randomUUID(); // member of A and B
const aOnlyUser = crypto.randomUUID(); // member of A only
const employeeA = crypto.randomUUID();
const employeeB = crypto.randomUUID();
const componentA = crypto.randomUUID();
const batchA = crypto.randomUUID();
const batchB = crypto.randomUUID();
const lineB = crypto.randomUUID();

/** A request-scoped transaction exactly as withAuth opens one; always rolled back. */
async function asUser<T>(userId: string, activeCompany: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [activeCompany]);
    return await als.run({ client, userId, companyId: activeCompany, claims: {} } as never, () => fn(client));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const insertBatch = (c: PoolClient | Pool, id: string, companyId: string, description: string) => c.query(
  `INSERT INTO payroll_batches (id, company_id, batch_type, description, period_year, period_month)
   VALUES ($1, $2, 'reimbursive_travel', $3, 2026, 5)`,
  [id, companyId, description]);

async function descriptionOf(id: string): Promise<string | null> {
  const r = await pool.query<{ description: string }>('SELECT description FROM payroll_batches WHERE id = $1', [id]);
  return r.rows[0]?.description ?? null;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [companyA, '897 RLS company A', companyB, '897 RLS company B']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true),($3,$4,'admin',true)",
    [bothUser, `${bothUser}@test.local`, aOnlyUser, `${aOnlyUser}@test.local`]);
  await pool.query(
    "INSERT INTO company_users(company_id,user_id,role) VALUES($1,$3,'admin'),($2,$3,'admin'),($1,$4,'admin')",
    [companyA, companyB, bothUser, aOnlyUser]);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
     VALUES($1,$2,'E-897-A','Ayanda','Zulu','2020-01-01','active'),($3,$4,'E-897-B','Johan','Smit','2020-01-01','active')`,
    [employeeA, companyA, employeeB, companyB]);
  await pool.query(
    `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable)
     VALUES($1,$2,'897 bonus','3605','earning',true)`,
    [componentA, companyA]);
  await insertBatch(pool, batchA, companyA, 'A batch');
  await insertBatch(pool, batchB, companyB, 'B batch');
  await pool.query(
    `INSERT INTO payroll_batch_lines(id,batch_id,employee_id,value,km,rate_per_km,effective_from)
     VALUES($1,$2,$3,500,100,5,'2026-05-01')`,
    [lineB, batchB, employeeB]);
});

afterAll(async () => {
  try {
    const companies = [companyA, companyB];
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = ANY($1::uuid[])', [[employeeA, employeeB]]);
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id IN (SELECT id FROM payroll_batches WHERE company_id = ANY($1::uuid[]))', [companies]);
    await pool.query('DELETE FROM payroll_batches WHERE company_id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_components WHERE company_id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[bothUser, aOnlyUser]]);
  } finally {
    await pool.end();
  }
});

describe('payroll_batches: a two-company member working in A cannot reach B (897)', () => {
  it('sees A\'s batch and not B\'s', async () => {
    const ids = await asUser(bothUser, companyA, async (c) =>
      (await c.query<{ id: string }>('SELECT id FROM payroll_batches WHERE id = ANY($1::uuid[])', [[batchA, batchB]]))
        .rows.map((r) => r.id));
    expect(ids).toEqual([batchA]);
  });

  it('does not see B\'s batch lines either (497 joins the parent)', async () => {
    const n = await asUser(bothUser, companyA, async (c) =>
      (await c.query<{ n: number }>('SELECT COUNT(*)::int n FROM payroll_batch_lines WHERE id = $1', [lineB])).rows[0]!.n);
    expect(n).toBe(0);
  });

  it('cannot update B\'s batch', async () => {
    const updated = await asUser(bothUser, companyA, async (c) =>
      (await c.query("UPDATE payroll_batches SET description = 'hijacked' WHERE id = $1", [batchB])).rowCount);
    expect(updated).toBe(0);
    expect(await descriptionOf(batchB)).toBe('B batch');
  });

  it('cannot delete B\'s batch', async () => {
    const deleted = await asUser(bothUser, companyA, async (c) =>
      (await c.query('DELETE FROM payroll_batches WHERE id = $1', [batchB])).rowCount);
    expect(deleted).toBe(0);
    expect(await descriptionOf(batchB)).toBe('B batch');
  });

  it('cannot insert a batch into B', async () => {
    await expect(asUser(bothUser, companyA, (c) => insertBatch(c, crypto.randomUUID(), companyB, 'planted')))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('cannot move A\'s batch into B', async () => {
    await expect(asUser(bothUser, companyA, (c) =>
      c.query('UPDATE payroll_batches SET company_id = $2 WHERE id = $1', [batchA, companyB])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('switching the active company to B reaches B again', async () => {
    const n = await asUser(bothUser, companyB, async (c) =>
      (await c.query<{ n: number }>('SELECT COUNT(*)::int n FROM payroll_batches WHERE id = $1', [batchB])).rows[0]!.n);
    expect(n).toBe(1);
  });
});

describe('payroll_batches: a non-member cannot use a forged company GUC', () => {
  it('a member of A only, with the GUC naming B, sees nothing of B and cannot write to it', async () => {
    const n = await asUser(aOnlyUser, companyB, async (c) =>
      (await c.query<{ n: number }>('SELECT COUNT(*)::int n FROM payroll_batches WHERE id = $1', [batchB])).rows[0]!.n);
    expect(n).toBe(0);
    await expect(asUser(aOnlyUser, companyB, (c) => insertBatch(c, crypto.randomUUID(), companyB, 'forged')))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('a member of A only, working in A, sees nothing of B', async () => {
    const n = await asUser(aOnlyUser, companyA, async (c) =>
      (await c.query<{ n: number }>('SELECT COUNT(*)::int n FROM payroll_batches WHERE id = $1', [batchB])).rows[0]!.n);
    expect(n).toBe(0);
  });
});

describe('payrollBatchService still works for the active company under app_user', () => {
  it('create, add lines, validate, list, get, post', async () => {
    await asUser(bothUser, companyA, async () => {
      const batch = await createBatch({
        companyId: companyA, batchType: 'component_values', componentId: componentA,
        description: '897 lifecycle', periodYear: 2026, periodMonth: 5, userId: bothUser,
      });
      expect(await addBatchLines(companyA, batch.id, [
        { employeeId: employeeA, value: 1200, effectiveFrom: new Date('2026-05-01') },
      ])).toEqual({ inserted: 1 });
      expect((await validateBatch(companyA, batch.id)).ok).toBe(true);
      const listed = (await listBatches(companyA)).map((b) => b.id);
      expect(listed).toContain(batch.id);
      expect(listed).not.toContain(batchB);
      const got = await getBatch(companyA, batch.id);
      expect(got.batch).toMatchObject({ status: 'validated', lineCount: 1, totalAmount: 1200 });
      expect(got.lines).toHaveLength(1);
      expect(await postBatch(companyA, batch.id, bothUser)).toEqual({ inserted: 1 });
      expect((await getBatch(companyA, batch.id)).batch.status).toBe('posted');
    });
  });

  it('cancel and delete', async () => {
    await asUser(bothUser, companyA, async () => {
      const make = () => createBatch({
        companyId: companyA, batchType: 'reimbursive_travel', description: '897 discard',
        periodYear: 2026, periodMonth: 5, userId: bothUser,
      });
      const toCancel = await make();
      await cancelBatch(companyA, toCancel.id);
      expect((await getBatch(companyA, toCancel.id)).batch.status).toBe('cancelled');
      const toDelete = await make();
      await deleteBatch(companyA, toDelete.id);
      expect((await listBatches(companyA)).map((b) => b.id)).not.toContain(toDelete.id);
    });
  });

  it('cannot fetch B\'s batch through the service with A active, even passing B\'s company id', async () => {
    await expect(asUser(bothUser, companyA, () => getBatch(companyB, batchB))).rejects.toThrow();
  });
});
