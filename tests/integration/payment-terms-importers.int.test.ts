/**
 * Migration 960 drops the payment_terms column defaults: the contact importers (the take-on file execute, the Sage
 * commit) name no terms, so they store NOT SET (NULL / NULL, the company default), never a confirmed-looking (30, 'days').
 * Through the real writers on a throwaway cluster; the stored rows are read back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { inRequest } from './r035-pr5.helpers';
import { insertCustomers, insertSuppliers } from '../../src/modules/accounting/services/core/migrationExecuteContacts';
import { upsertCustomer, upsertSupplier } from '../../src/modules/admin/services/sageMigrationCommitService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';

beforeAll(async () => { [admin] = await members(pool, tokens, 1); });
afterAll(async () => {
  await pool.query('DELETE FROM customers WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM suppliers WHERE company_id = ANY($1)', [companies]);
  await cleanupEntityChanges(pool, companies, [admin]);
});

const termsOf = async (table: 'customers' | 'suppliers', c: string, name: string) =>
  (await pool.query(`SELECT payment_terms, payment_terms_type FROM ${table} WHERE company_id = $1 AND name = $2`, [c, name])).rows;
const NOT_SET = [{ payment_terms: null, payment_terms_type: null }];

describe('importers store terms NOT SET, not a column default', () => {
  it('the column defaults are gone: an insert naming no terms stores NULL / NULL', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    await pool.query("INSERT INTO suppliers(company_id, name) VALUES($1, 'bare supplier')", [c]);
    await pool.query("INSERT INTO customers(company_id, name) VALUES($1, 'bare customer')", [c]);
    expect(await termsOf('suppliers', c, 'bare supplier')).toEqual(NOT_SET);
    expect(await termsOf('customers', c, 'bare customer')).toEqual(NOT_SET);
  });

  it('the take-on file execute (insertCustomers / insertSuppliers)', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    await inRequest(pool, admin, c, async () => {
      await insertCustomers(c, [{ name: 'Take-on customer' } as never]);
      await insertSuppliers(c, [{ name: 'Take-on supplier' } as never]);
    });
    expect(await termsOf('customers', c, 'Take-on customer')).toEqual(NOT_SET);
    expect(await termsOf('suppliers', c, 'Take-on supplier')).toEqual(NOT_SET);
  });

  it('the Sage commit (upsertCustomer / upsertSupplier)', async () => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    await inRequest(pool, admin, c, async () => {
      await upsertCustomer(c, { name: 'Sage customer' } as never);
      await upsertSupplier(c, { name: 'Sage supplier' } as never);
    });
    expect(await termsOf('customers', c, 'Sage customer')).toEqual(NOT_SET);
    expect(await termsOf('suppliers', c, 'Sage supplier')).toEqual(NOT_SET);
  });
});
