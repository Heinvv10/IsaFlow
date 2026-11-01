/**
 * Fixture for wave 3 K1 (employee bank details, migration 952): one employee per case, the route called as each
 * member, the table read back as its owner, and the service run the way a service-pool path would run it, where
 * app_service's USING (true) mirror (915) leaves the service's own company predicate as the only tenant check.
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import bankDetails from '../../pages/api/payroll/employees/[id]/bank-details';
import { callRoute } from './r035-approval.helpers';

export const ROW = { bankName: 'FNB', branchCode: '250655', accountNumber: '62000123456', accountType: 'cheque', accountHolder: 'K One' };
export const OTHER = { ...ROW, bankName: 'Capitec', branchCode: '470010', accountNumber: '1357924680', accountType: 'savings' };

export async function employee(pool: Pool, company: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth)
     VALUES ($1, $2, 'Kay', 'One', '2020-01-01', '1985-01-01') RETURNING id`, [company, `K1-${crypto.randomUUID().slice(0, 8)}`]);
  return rows[0]!.id;
}

export const url = (id: string) => `/api/payroll/employees/${id}/bank-details`;
export const put = (token: string, company: string, id: string, body: unknown, contentType?: string) =>
  callRoute(bankDetails, token, company, 'PUT', body, url(id), { id }, contentType === undefined ? {} : { 'content-type': contentType });
export const get = (token: string, company: string, id: string) =>
  callRoute(bankDetails, token, company, 'GET', undefined, url(id), { id });

export interface BankRow { id: string; company_id: string; is_active: boolean; account_number: string; effective_from: string }

/** Every row of the employee, oldest first, read as the table owner. */
export async function rowsOf(pool: Pool, employeeId: string): Promise<BankRow[]> {
  const { rows } = await pool.query<BankRow>(
    `SELECT id, company_id, is_active, account_number, effective_from::text AS effective_from
     FROM payroll_bank_details WHERE employee_id = $1 ORDER BY created_at, id`, [employeeId]);
  return rows;
}

/** `fn` as a service-pool path: app_service, the company in ALS, rolled back. */
export async function asService<T>(pool: Pool, company: string, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_service');
    return await als.run({ client, companyId: company, claims: {}, afterCommit: [] } as never, fn);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
