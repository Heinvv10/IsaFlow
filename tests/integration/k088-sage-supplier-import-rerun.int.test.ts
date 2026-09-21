/**
 * K-088 — the Sage supplier-invoice importer does not book a bill twice when it
 * is re-run after `resetMigration`, on real PostgreSQL. Before R-021 the loop
 * was unreachable (42703), so the missing guard was latent; reviving the
 * importer without one would duplicate every bill on a re-run.
 *
 * Own company, so no other suite's pending rows join the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { importSupplierInvoices } from '@/modules/accounting/services/core/sageImportService';
import { resetMigration } from '@/modules/accounting/services/core/sageMigrationCompareService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageImportHarness } from './r021-sage-supplier-import.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companyC = randomUUID();
const user = randomUUID();
const SUPPLIER_NAME = 'K088 Supplier';
const { drive, seedStaging } = sageImportHarness(pool, user);

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyC, 'K088 company']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyC, user]);
  await pool.query(
    'INSERT INTO suppliers(company_id,name,vat_number,payment_terms) VALUES($1,$2,$3,30)',
    [companyC, SUPPLIER_NAME, `41${companyC.slice(0, 8)}`],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM sage_supplier_invoices WHERE company_id=$1', [companyC]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [companyC]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [companyC]);
    await pool.query('DELETE FROM gl_migration_runs WHERE company_id=$1', [companyC]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [companyC]);
    await pool.query('DELETE FROM companies WHERE id=$1', [companyC]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('K-088: a re-run after reset does not book the bill twice', () => {
  it('links the staged row to the bill already in AP and counts it skipped', async () => {
    const tag = `K088-${randomUUID().slice(0, 8)}`;
    const stagingId = await seedStaging(companyC, {
      sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: SUPPLIER_NAME, total: 575,
    });

    const first = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(first.succeeded).toBe(1);
    await drive(companyC, () => resetMigration(companyC, 'invoices'));
    const second = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(second.succeeded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.failed).toBe(0);

    const bills = (await pool.query(
      'SELECT id FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2', [companyC, `${tag}-SAGE`],
    )).rows;
    expect(bills).toHaveLength(1);
    const staging = (await pool.query(
      'SELECT migration_status, gl_supplier_invoice_id FROM sage_supplier_invoices WHERE id=$1', [stagingId],
    )).rows[0]!;
    expect(staging.migration_status).toBe('imported');
    expect(staging.gl_supplier_invoice_id).toBe(bills[0]!.id);
  });

  it('imports again once the earlier bill is soft-deleted', async () => {
    const tag = `K088D-${randomUUID().slice(0, 8)}`;
    await seedStaging(companyC, { sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: SUPPLIER_NAME, total: 640 });
    await drive(companyC, () => importSupplierInvoices(companyC, user));
    await pool.query(
      'UPDATE supplier_invoices SET deleted_at=NOW() WHERE company_id=$1 AND sage_invoice_id=$2', [companyC, `${tag}-SAGE`],
    );
    await drive(companyC, () => resetMigration(companyC, 'invoices'));
    const again = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(again.succeeded).toBe(1);
    const live = (await pool.query(
      'SELECT id FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2 AND deleted_at IS NULL',
      [companyC, `${tag}-SAGE`],
    )).rows;
    expect(live).toHaveLength(1);
  });
});
