/**
 * R-101 review round 1 (adversarial REPRO4): a Sage staging row's link to the
 * document it became must not block executeArchive, which DELETEs old paid
 * invoices after copying them to the archive tables. Migration 694 makes both
 * links ON DELETE SET NULL; before it, a NO ACTION reference failed the whole
 * archive run (the supplier link from 205 had the same latent defect).
 * Round 2: with the link NULL, a reset re-pends the row, so both importers
 * treat an archived holder of the document as a conflict.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { importCustomerInvoices } from '@/modules/accounting/services/core/sageCustomerImportService';
import { importSupplierInvoices } from '@/modules/accounting/services/core/sageImportService';
import { executeArchive } from '@/modules/accounting/services/core/archiveExecutionService';
import { resetMigration } from '@/modules/accounting/services/core/sageMigrationCompareService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageImportHarness } from './r021-sage-supplier-import.helpers';
import { sageCustomerStaging } from './r101-sage-customer-import.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = randomUUID();
const user = randomUUID();
const NAME = 'R101AR Counterparty';

const supplierHarness = sageImportHarness(pool, user);
const { drive } = supplierHarness;
const { seedStaging, staged, addCustomer, setUp, tearDown } = sageCustomerStaging(pool);

beforeAll(async () => {
  await setUp([[company, 'R101 archive company']], user);
  await addCustomer(company, NAME);
  await pool.query('INSERT INTO suppliers(company_id,name) VALUES($1,$2)', [company, NAME]);
});

afterAll(async () => {
  for (const t of ['archive_customer_invoices', 'archive_supplier_invoices', 'archive_runs', 'sage_supplier_invoices', 'supplier_invoices', 'suppliers']) {
    await pool.query(`DELETE FROM ${t} WHERE company_id=$1`, [company]);
  }
  await tearDown([company], user);
});

describe('R-101: an imported Sage document can still be archived', () => {
  it('archives a paid imported customer invoice and a paid imported bill; the staging links go NULL', async () => {
    const custStaging = await seedStaging(company, {
      sageId: 'R101AR-C', invoiceNumber: 'R101AR-CINV', customerName: NAME, total: 300, invoiceDate: '2020-01-15',
    });
    const supStaging = await supplierHarness.seedStaging(company, {
      sageId: 'R101AR-S', invoiceNumber: 'R101AR-SINV', supplierName: NAME, total: 400, invoiceDate: '2020-01-15',
    });
    expect((await drive(company, () => importCustomerInvoices(company, user))).succeeded).toBe(1);
    expect((await drive(company, () => importSupplierInvoices(company, user))).succeeded).toBe(1);
    await pool.query("UPDATE customer_invoices SET status='paid', amount_paid=total_amount WHERE company_id=$1", [company]);
    await pool.query("UPDATE supplier_invoices SET status='paid', amount_paid=total_amount WHERE company_id=$1", [company]);

    const result = await drive(company, () => executeArchive(company, '2021-01-01', user));
    expect(result.invoicesArchived).toBe(1);
    expect(result.supplierInvoicesArchived).toBe(1);

    expect(await staged(custStaging)).toEqual({ migration_status: 'imported', gl_customer_invoice_id: null });
    const sup = (await pool.query(
      'SELECT gl_supplier_invoice_id FROM sage_supplier_invoices WHERE id=$1', [supStaging],
    )).rows[0]!;
    expect(sup.gl_supplier_invoice_id).toBeNull();

    // Review round 2: a reset then re-pends both rows. The re-run must not book
    // the archived, settled debts again as live unpaid documents.
    await drive(company, () => resetMigration(company, 'customer_invoices'));
    await drive(company, () => resetMigration(company, 'invoices'));
    expect((await drive(company, () => importCustomerInvoices(company, user))).failed).toBe(1);
    expect((await drive(company, () => importSupplierInvoices(company, user))).failed).toBe(1);
    const live = async (table: string) => (await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE company_id=$1`, [company])).rows[0]!.n;
    expect(await live('customer_invoices')).toBe(0);
    expect(await live('supplier_invoices')).toBe(0);
  });
});
