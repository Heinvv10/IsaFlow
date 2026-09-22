/**
 * R-021 / K-090 / K-088 — the Sage supplier-invoice importer, on real PostgreSQL.
 *
 * R-021: `importSupplierInvoices` SELECTed eleven columns `sage_supplier_invoices`
 *   has never had, so the first statement raised 42703 for every tenant and no
 *   bill ever reached the row loop. RED log:
 *   docs/audits/remediation/R-021/red.log (2 failed / 2, under the validator's
 *   original file name k088-k090-sage-importers-schema-unreachable.int.test.ts).
 * K-090 (recovery from a failed statement) is in k090-sage-import-run-recovery.int.test.ts.
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
import { SAGE_VAT_NOT_STATED_NOTE } from '@/modules/accounting/services/shared/sageVatDerivation';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageImportHarness } from './r021-sage-supplier-import.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companyA = randomUUID();
const companyB = randomUUID();
const user = randomUUID();
const SUPPLIER_NAME = 'R021 Supplier';

const { drive, seedStaging, fmt } = sageImportHarness(pool, user);

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

  it('gives a supplier with no payment terms no due date rather than an invented one', async () => {
    const tag = `R021T0-${randomUUID().slice(0, 8)}`;
    const name = `${tag} Termless`;
    await pool.query('INSERT INTO suppliers(company_id,name,payment_terms) VALUES($1,$2,NULL)', [companyA, name]);
    await seedStaging(companyA, { sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: name, total: 100 });
    const result = await drive(companyA, () => importSupplierInvoices(companyA, user));
    expect(result.succeeded).toBe(1);
    const bill = (await pool.query(
      'SELECT due_date FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2', [companyA, `${tag}-SAGE`],
    )).rows[0]!;
    expect(bill.due_date).toBeNull();
  });

  it('uses the supplier’s own terms for the due date', async () => {
    const tag = `R021T45-${randomUUID().slice(0, 8)}`;
    const name = `${tag} Net45`;
    await pool.query('INSERT INTO suppliers(company_id,name,payment_terms) VALUES($1,$2,45)', [companyA, name]);
    await seedStaging(companyA, { sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: name, total: 100 });
    await drive(companyA, () => importSupplierInvoices(companyA, user));
    const bill = (await pool.query(
      'SELECT due_date FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2', [companyA, `${tag}-SAGE`],
    )).rows[0]!;
    expect(fmt(bill.due_date)).toBe('2026-08-14');
  });

  it.each([-500, 0])('fails a row whose total is %s instead of booking it as a bill', async (total) => {
    const tag = `R021NEG-${randomUUID().slice(0, 8)}`;
    const stagingId = await seedStaging(companyA, {
      sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: SUPPLIER_NAME, total,
    });
    const result = await drive(companyA, () => importSupplierInvoices(companyA, user));
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect((await pool.query('SELECT migration_status FROM sage_supplier_invoices WHERE id=$1', [stagingId])).rows[0]!.migration_status).toBe('failed');
    expect((await pool.query('SELECT id FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2', [companyA, `${tag}-SAGE`])).rows).toHaveLength(0);
  });

  it('matches a supplier stored with surrounding whitespace', async () => {
    const tag = `R021WS-${randomUUID().slice(0, 8)}`;
    const live = (await pool.query<{ id: string }>(
      'INSERT INTO suppliers(company_id,name) VALUES($1,$2) RETURNING id', [companyA, `  ${tag} Padded  `],
    )).rows[0]!.id;
    await seedStaging(companyA, { sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: `${tag} Padded`, total: 50 });
    const result = await drive(companyA, () => importSupplierInvoices(companyA, user));
    expect(result.succeeded).toBe(1);
    const bill = (await pool.query(
      'SELECT supplier_id FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2', [companyA, `${tag}-SAGE`],
    )).rows[0]!;
    expect(bill.supplier_id).toBe(live);
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
