/**
 * K-061, Hein's decision 4 (2026-09-26): after a merge the source stays
 * soft-deleted with its Sage history. The customer importers match by NAME,
 * so a Sage re-sync re-creates the merged-away name as a new, empty customer
 * (accepted and documented). What must NOT happen is the debt being booked
 * twice: the Sage invoice the merge moved to the survivor is refused when the
 * re-sync offers it again under the re-created customer.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { importCustomerInvoices } from '@/modules/accounting/services/core/sageCustomerImportService';
import { upsertCustomer } from '@/modules/admin/services/sageMigrationCommitService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageImportHarness } from './r021-sage-supplier-import.helpers';
import { sageCustomerStaging } from './r101-sage-customer-import.helpers';
import { k061 } from './k061-customer-merge.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const h = k061(pool);
const { drive } = sageImportHarness(pool, h.admin);
const staging = sageCustomerStaging(pool);

beforeAll(h.setUp);
afterAll(async () => {
  await pool.query('DELETE FROM sage_customer_invoices WHERE company_id=$1', [h.companyA]);
  await pool.query('DELETE FROM gl_migration_runs WHERE company_id=$1', [h.companyA]);
  await h.tearDown();
});
beforeEach(async () => {
  await pool.query('DELETE FROM sage_customer_invoices WHERE company_id=$1', [h.companyA]);
  await h.wipe();
});

it('a re-sync after a merge re-creates the name but cannot book the moved Sage invoice twice', async () => {
  const source = await h.customer(h.companyA, 'Sage Dup Traders');
  const target = await h.customer(h.companyA, 'Sage Survivor Traders');
  await staging.addInvoice(h.companyA, source, h.admin, { number: 'SG-INV-1', total: 500, externalRef: 'SG-1' });

  const merged = await h.merge({ source_id: source, target_id: target });
  expect(merged.state.statusCode).toBe(200);

  // The customer re-sync matches by name; the source is renamed and deleted, so
  // it gets a NEW customer — never the archived source back.
  const recreated = await drive(h.companyA, () => upsertCustomer(h.companyA, {
    name: 'Sage Dup Traders', email: null, phone: null, vatNumber: null, contactPerson: null, creditLimit: 0,
  } as never));
  expect(recreated).not.toBe(source);
  const src = await pool.query('SELECT deleted_at IS NOT NULL AS gone FROM customers WHERE id=$1', [source]);
  expect(src.rows[0].gone).toBe(true);

  await staging.seedStaging(h.companyA, { sageId: 'SG-1', invoiceNumber: 'SG-INV-1', customerName: 'Sage Dup Traders', total: 500 });
  const run = await drive(h.companyA, () => importCustomerInvoices(h.companyA, h.admin));
  expect(run.failed).toBe(1);

  const { rows } = await pool.query(
    `SELECT COALESCE(client_id, customer_id) AS who, sum(total_amount)::float8 AS owed
     FROM customer_invoices WHERE company_id=$1 AND deleted_at IS NULL GROUP BY 1`, [h.companyA]);
  expect(rows).toEqual([{ who: target, owed: 500 }]);
});
