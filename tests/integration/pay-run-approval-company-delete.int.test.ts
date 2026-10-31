/**
 * Migration 951: fixed pay-run approval rows stay immutable while their
 * company exists, but a company purge can cascade them away.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];

afterAll(async () => {
  for (const companyId of companies) {
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
  }
  await pool.end();
});

async function company(): Promise<string> {
  const id = crypto.randomUUID();
  companies.push(id);
  await pool.query('INSERT INTO companies(id, name) VALUES($1, $2)', [id, `Payroll approval ${id.slice(0, 8)}`]);
  return id;
}

async function sqlState(query: string, params: unknown[]): Promise<string> {
  try {
    await pool.query(query, params);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

describe('pay-run approval company teardown', () => {
  it('exposes no approvable document until a calculation records its author and digest', async () => {
    const companyId = await company();
    const runId = crypto.randomUUID();
    await pool.query(
      'INSERT INTO payroll_run_headers(id, company_id, period_month, period_year) VALUES($1, $2, 10, 2098)',
      [runId, companyId],
    );

    expect((await pool.query(
      "SELECT * FROM approval_request_document_facts($1, 'pay_run', $2)",
      [companyId, runId],
    )).rows).toEqual([]);

    await pool.query(
      'UPDATE payroll_run_headers SET prepared_by = $2, approval_plan_hash = $3 WHERE id = $1',
      [runId, crypto.randomUUID(), 'reviewed-plan'],
    );
    expect((await pool.query(
      "SELECT digest FROM approval_request_document_facts($1, 'pay_run', $2)",
      [companyId, runId],
    )).rows).toEqual([{ digest: 'reviewed-plan' }]);
    await pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [runId]);
  });

  it('refuses standalone deletion of either fixed row while the company exists', async () => {
    const companyId = await company();

    expect(await sqlState(
      "DELETE FROM approval_rules WHERE company_id = $1 AND document_type = 'pay_run'",
      [companyId],
    )).toBe('RA035');
    expect(await sqlState(
      "DELETE FROM approval_enforcement WHERE company_id = $1 AND document_type = 'pay_run'",
      [companyId],
    )).toBe('RA035');
  });

  it('deletes the fixed rows when their owning company is purged', async () => {
    const companyId = await company();

    expect(await sqlState('DELETE FROM companies WHERE id = $1', [companyId])).toBe('ok');
    companies.splice(companies.indexOf(companyId), 1);
    const { rows: [remaining] } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM approval_rules WHERE company_id = $1) AS rules,
         (SELECT count(*)::int FROM approval_enforcement WHERE company_id = $1) AS enforcement`,
      [companyId],
    );
    expect(remaining).toEqual({ rules: 0, enforcement: 0 });
  });
});
