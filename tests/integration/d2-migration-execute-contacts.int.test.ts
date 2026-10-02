/**
 * D2 — a migration execute with suppliers and customers imports both, on the
 * migration-created schema. executeMigration's supplier INSERT named
 * suppliers.billing_address, a column no migration creates (the table has
 * `address`), so every supplier of every execute failed.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { executeMigration } from '../../src/modules/accounting/services/core/migrationExecuteService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'D2 contacts fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('imports suppliers and customers with their addresses', async () => {
  const result = await executeMigration(company, user, 'xero', [],
    [{ name: 'Cust One', email: 'c1@x.test', phone: '011', vatNumber: '4111111111', address: '1 Main Rd, Sandton' }],
    [{ name: 'Supp One', email: 's1@x.test', phone: '012', vatNumber: '4222222222', address: '2 Dock St, Durban' }]);

  expect(result.errors).toEqual([]);
  expect(result.customersImported).toBe(1);
  expect(result.suppliersImported).toBe(1);
  const cust = await pool.query('SELECT billing_address, vat_number FROM customers WHERE company_id=$1', [company]);
  expect(cust.rows).toEqual([{ billing_address: '1 Main Rd, Sandton', vat_number: '4111111111' }]);
  const supp = await pool.query('SELECT address, vat_number FROM suppliers WHERE company_id=$1', [company]);
  expect(supp.rows).toEqual([{ address: '2 Dock St, Durban', vat_number: '4222222222' }]);
});
