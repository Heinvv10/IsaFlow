/**
 * R-021 / K-090 / K-088 — the Sage supplier-invoice importer, on real PostgreSQL.
 *
 * R-021: `importSupplierInvoices` SELECTed eleven columns `sage_supplier_invoices`
 *   has never had, so the first statement raised 42703 for every tenant and no
 *   bill ever reached the row loop. RED log:
 *   docs/audits/remediation/R-021/red.log (2 failed / 2, under the validator's
 *   original file name k088-k090-sage-importers-schema-unreachable.int.test.ts).
 * K-090: the failure then ran recovery SQL on the aborted request transaction,
 *   so the operator saw 25P02 instead of the real cause and the run was never
 *   marked failed.
 * K-088 (re-run after reset) is in k088-sage-supplier-import-rerun.int.test.ts.
 * R-089: staging carries no VAT figure, so the bill records none and is
 *   flagged — never a 15% unwind of the total.
 *
 * Every case drives the service inside an `als` request transaction, exactly as
 * `withAuth` does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { importSupplierInvoices } from '@/modules/accounting/services/core/sageImportService';
import { importCustomerInvoices } from '@/modules/accounting/services/core/sageCustomerImportService';
import { SAGE_VAT_NOT_STATED_NOTE } from '@/modules/accounting/services/shared/sageVatDerivation';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageImportHarness } from './r021-sage-supplier-import.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companyA = randomUUID();
const companyB = randomUUID();
const user = randomUUID();
const SUPPLIER_NAME = 'R021 Supplier';

const { drive, driveExpectingFailure, seedStaging, fmt } = sageImportHarness(pool, user);

beforeAll(async () => {
  for (const [id, name] of [[companyA, 'R021 company A'], [companyB, 'R021 company B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const id of [companyA, companyB]) {
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [id, user]);
    await pool.query(
      'INSERT INTO suppliers(company_id,name,vat_number,payment_terms) VALUES($1,$2,$3,30)',
      [id, SUPPLIER_NAME, `41${id.slice(0, 8)}`],
    );
  }
});

afterAll(async () => {
  try {
    for (const id of [companyA, companyB]) {
      await pool.query('DELETE FROM sage_supplier_invoices WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM suppliers WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM gl_migration_runs WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('R-021: the importer reads the columns its source table actually has', () => {
  it('imports a staged bill end to end and agrees with the staged total', async () => {
    const tag = `R021-${randomUUID().slice(0, 8)}`;
    const stagingId = await seedStaging(companyA, {
      sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: SUPPLIER_NAME, total: 1150,
    });

    const result = await drive(companyA, () => importSupplierInvoices(companyA, user));
    expect(result.status).toBe('completed');
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const bill = (await pool.query(
      `SELECT invoice_number, supplier_id, subtotal, tax_rate, tax_amount, total_amount,
              amount_paid, balance, status, sage_invoice_id, invoice_date, due_date, notes
         FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2`,
      [companyA, `${tag}-SAGE`],
    )).rows;
    expect(bill).toHaveLength(1);
    const b = bill[0]!;
    // The AP document agrees with the staged total, and its VAT split adds back
    // to it — a bill whose parts do not foot is a permanent AP/GL difference.
    expect(Number(b.total_amount)).toBe(1150);
    expect(Number(b.subtotal) + Number(b.tax_amount)).toBe(1150);
    // R-089: staging states no VAT, so none is invented.
    expect(Number(b.subtotal)).toBe(1150);
    expect(Number(b.tax_amount)).toBe(0);
    expect(Number(b.tax_rate)).toBe(0);
    expect(b.notes).toBe(SAGE_VAT_NOT_STATED_NOTE);
    expect(result.vatNotStated).toBe(1);
    // Unpaid: staging carries no payment, so the full amount stays outstanding.
    expect(Number(b.amount_paid)).toBe(0);
    expect(Number(b.balance)).toBe(1150);
    expect(b.status).toBe('approved');
    expect(b.invoice_number).toBe(`${tag}-INV`);
    // Due date = invoice date + the supplier's own 30-day terms.
    expect(fmt(b.due_date)).toBe('2026-07-30');

    const staging = (await pool.query(
      'SELECT migration_status, gl_supplier_invoice_id FROM sage_supplier_invoices WHERE id=$1',
      [stagingId],
    )).rows[0]!;
    expect(staging.migration_status).toBe('imported');
    expect(staging.gl_supplier_invoice_id).toBeTruthy();
  });

  it('fails the row rather than inventing a supplier when the name matches none', async () => {
    const tag = `R021N-${randomUUID().slice(0, 8)}`;
    const stagingId = await seedStaging(companyA, {
      sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: 'Nobody At All', total: 500,
    });

    const result = await drive(companyA, () => importSupplierInvoices(companyA, user));
    expect(result.status).toBe('partial');
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);

    const staging = (await pool.query(
      'SELECT migration_status FROM sage_supplier_invoices WHERE id=$1', [stagingId],
    )).rows[0]!;
    expect(staging.migration_status).toBe('failed');
    const bills = (await pool.query(
      'SELECT id FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2',
      [companyA, `${tag}-SAGE`],
    )).rows;
    expect(bills).toHaveLength(0);
  });

  it('fails the row when the name matches more than one live supplier', async () => {
    const tag = `R021A-${randomUUID().slice(0, 8)}`;
    const twin = `${tag} Twin`;
    await pool.query('INSERT INTO suppliers(company_id,name) VALUES($1,$2),($1,$3)', [companyA, twin, twin.toUpperCase()]);
    const stagingId = await seedStaging(companyA, {
      sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: twin, total: 700,
    });

    const result = await drive(companyA, () => importSupplierInvoices(companyA, user));
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    const staging = (await pool.query(
      'SELECT migration_status FROM sage_supplier_invoices WHERE id=$1', [stagingId],
    )).rows[0]!;
    expect(staging.migration_status).toBe('failed');
    const bills = (await pool.query(
      'SELECT id FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2', [companyA, `${tag}-SAGE`],
    )).rows;
    expect(bills).toHaveLength(0);
  });

  it('ignores a soft-deleted supplier of the same name', async () => {
    const tag = `R021D-${randomUUID().slice(0, 8)}`;
    const name = `${tag} Reborn`;
    await pool.query('INSERT INTO suppliers(company_id,name,deleted_at) VALUES($1,$2,NOW())', [companyA, name]);
    const live = (await pool.query<{ id: string }>(
      'INSERT INTO suppliers(company_id,name) VALUES($1,$2) RETURNING id', [companyA, name],
    )).rows[0]!.id;
    await seedStaging(companyA, { sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: name, total: 320 });

    const result = await drive(companyA, () => importSupplierInvoices(companyA, user));
    expect(result.succeeded).toBe(1);
    const bill = (await pool.query(
      'SELECT supplier_id FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2', [companyA, `${tag}-SAGE`],
    )).rows;
    expect(bill).toHaveLength(1);
    expect(bill[0]!.supplier_id).toBe(live);
  });

  it('leaves another tenant’s pending rows alone', async () => {
    const tag = `R021T-${randomUUID().slice(0, 8)}`;
    const bStagingId = await seedStaging(companyB, {
      sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: SUPPLIER_NAME, total: 2300,
    });

    await drive(companyA, () => importSupplierInvoices(companyA, user));

    const staging = (await pool.query(
      'SELECT migration_status FROM sage_supplier_invoices WHERE id=$1', [bStagingId],
    )).rows[0]!;
    expect(staging.migration_status).toBe('pending');
    const bBills = (await pool.query(
      'SELECT id FROM supplier_invoices WHERE company_id=$1', [companyB],
    )).rows;
    expect(bBills).toHaveLength(0);
    // Nor may B's staged row be booked into A's AP under A's same-named supplier.
    const leaked = (await pool.query(
      'SELECT id FROM supplier_invoices WHERE sage_invoice_id=$1', [`${tag}-SAGE`],
    )).rows;
    expect(leaked).toHaveLength(0);
  });
});

describe('K-090: a failed run reports its own cause and is recorded', () => {
  it('surfaces the original error, not 25P02, and marks the run failed with it', async () => {
    // The customer-invoice importer still SELECTs columns
    // sage_customer_invoices does not have — the sibling of R-021, left open
    // deliberately (see docs/audits/remediation/R-021/fix.md). It is the
    // honest vehicle for an outer-handler failure: before this fix the caller
    // saw "current transaction is aborted" from failRun's own UPDATE and the
    // run stayed 'running'.
    const outcome = await driveExpectingFailure(companyB, () => importCustomerInvoices(companyB, user));

    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toMatch(/does not exist/);
    expect(outcome.error.message).not.toMatch(/current transaction is aborted/);
    expect(outcome.status).toBe('failed');
    expect(outcome.errorMessage).toMatch(/does not exist/);
  });

  it('recovers the transaction after a row-level failure and marks that row failed', async () => {
    // invoice_date is nullable in staging and NOT NULL on supplier_invoices,
    // so this row raises 23502 inside the per-row INSERT. Before the per-row
    // savepoint, the markFailed UPDATE that follows ran on the transaction
    // that INSERT had just aborted.
    const tag = `K090R-${randomUUID().slice(0, 8)}`;
    const badId = (await pool.query<{ id: string }>(
      `INSERT INTO sage_supplier_invoices
         (company_id, sage_id, invoice_number, supplier_name, invoice_date, total_amount, migration_status)
       VALUES ($1,$2,$3,$4,NULL,900,'pending') RETURNING id`,
      [companyA, `${tag}-SAGE`, `${tag}-INV`, SUPPLIER_NAME],
    )).rows[0]!.id;
    const goodId = await seedStaging(companyA, {
      sageId: `${tag}-OK`, invoiceNumber: `${tag}-OKINV`, supplierName: SUPPLIER_NAME, total: 1150,
    });

    // The run must COMPLETE — the whole point is that one bad row no longer
    // takes the transaction, and therefore the request, down with it.
    const result = await drive(companyA, () => importSupplierInvoices(companyA, user));
    expect(result.status).toBe('partial');
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);

    const rows = (await pool.query(
      'SELECT id, migration_status FROM sage_supplier_invoices WHERE id = ANY($1)',
      [[badId, goodId]],
    )).rows;
    expect(rows.find(r => r.id === badId)!.migration_status).toBe('failed');
    expect(rows.find(r => r.id === goodId)!.migration_status).toBe('imported');
  });
});
