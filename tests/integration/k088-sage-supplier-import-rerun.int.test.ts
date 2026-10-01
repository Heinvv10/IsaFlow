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
const billsFor = async (sageId: string) => (await pool.query(
  'SELECT id, supplier_id FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id=$2 AND deleted_at IS NULL', [companyC, sageId],
)).rows;

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
  it('still links after the supplier’s VAT number changed between runs (identity is the Sage id, not the fingerprint)', async () => {
    const tag = `K088V-${randomUUID().slice(0, 8)}`;
    const stagingId = await seedStaging(companyC, { sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: SUPPLIER_NAME, total: 810 });
    await drive(companyC, () => importSupplierInvoices(companyC, user));
    await pool.query('UPDATE suppliers SET vat_number=$1 WHERE company_id=$2 AND name=$3', [`49${tag.slice(-6)}`, companyC, SUPPLIER_NAME]);
    // resetMigration re-pends every row of the company, so judge by this row.
    await drive(companyC, () => resetMigration(companyC, 'invoices'));
    const again = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(again.failed).toBe(0);
    const bills = await billsFor(`${tag}-SAGE`);
    expect(bills).toHaveLength(1);
    const row = (await pool.query('SELECT migration_status, gl_supplier_invoice_id FROM sage_supplier_invoices WHERE id=$1', [stagingId])).rows[0]!;
    expect(row.migration_status).toBe('imported');
    expect(row.gl_supplier_invoice_id).toBe(bills[0]!.id);
  });

  it('fails, not merges, a distinct Sage invoice that reuses a number already booked for the supplier', async () => {
    const tag = `K088N-${randomUUID().slice(0, 8)}`;
    await seedStaging(companyC, { sageId: `${tag}-S1`, invoiceNumber: 'RENT', supplierName: SUPPLIER_NAME, total: 10000, invoiceDate: '2026-05-31' });
    const second = await seedStaging(companyC, { sageId: `${tag}-S2`, invoiceNumber: 'RENT', supplierName: SUPPLIER_NAME, total: 10000, invoiceDate: '2026-06-30' });
    const result = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(await billsFor(`${tag}-S1`)).toHaveLength(1);
    expect(await billsFor(`${tag}-S2`)).toHaveLength(0);
    const row = (await pool.query('SELECT migration_status, gl_supplier_invoice_id FROM sage_supplier_invoices WHERE id=$1', [second])).rows[0]!;
    expect(row.migration_status).toBe('failed');
    expect(row.gl_supplier_invoice_id).toBeNull();
  });

  it('books the same invoice number for two different suppliers as two bills', async () => {
    const tag = `K088P-${randomUUID().slice(0, 8)}`;
    const ids: string[] = [];
    for (const n of ['One', 'Two']) {
      ids.push((await pool.query<{ id: string }>(
        'INSERT INTO suppliers(company_id,name) VALUES($1,$2) RETURNING id', [companyC, `${tag} ${n}`],
      )).rows[0]!.id);
      await seedStaging(companyC, { sageId: `${tag}-${n}`, invoiceNumber: `${tag}-SHARED`, supplierName: `${tag} ${n}`, total: 250 });
    }
    const result = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(result.succeeded).toBe(2);
    expect((await billsFor(`${tag}-One`))[0]!.supplier_id).toBe(ids[0]);
    expect((await billsFor(`${tag}-Two`))[0]!.supplier_id).toBe(ids[1]);
  });

  it('two concurrent runs book each pending row once and leave no row failed', async () => {
    const tag = `K088C-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 4; i++) {
      await seedStaging(companyC, { sageId: `${tag}-${i}`, invoiceNumber: `${tag}-INV${i}`, supplierName: SUPPLIER_NAME, total: 100 + i });
    }
    const runs = await Promise.all([
      drive(companyC, () => importSupplierInvoices(companyC, user)),
      drive(companyC, () => importSupplierInvoices(companyC, user)),
    ]);
    expect(runs.map(r => r.failed)).toEqual([0, 0]);
    expect(runs[0]!.succeeded + runs[1]!.succeeded).toBe(4);
    const staged = (await pool.query(
      "SELECT migration_status FROM sage_supplier_invoices WHERE company_id=$1 AND sage_id LIKE $2", [companyC, `${tag}-%`],
    )).rows;
    expect(staged.every(r => r.migration_status === 'imported')).toBe(true);
    const bills = (await pool.query(
      'SELECT count(*)::int AS n FROM supplier_invoices WHERE company_id=$1 AND sage_invoice_id LIKE $2', [companyC, `${tag}-%`],
    )).rows[0]!.n;
    expect(bills).toBe(4);
  });
  it('does not link a staged row to another supplier’s bill that happens to carry the same Sage id', async () => {
    const tag = `K088X-${randomUUID().slice(0, 8)}`;
    const other = (await pool.query<{ id: string }>(
      'INSERT INTO suppliers(company_id,name) VALUES($1,$2) RETURNING id', [companyC, `${tag} Other`],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount, status, sage_invoice_id, created_by)
       VALUES ($1, $2, $3, '2026-06-01', 90, 90, 'approved', $4, $5)`,
      [companyC, `${tag}-OTHER`, other, `${tag}-SAGE`, user],
    );
    await seedStaging(companyC, { sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-MINE`, supplierName: SUPPLIER_NAME, total: 90 });
    const result = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(result.succeeded).toBe(1);
    const bills = await billsFor(`${tag}-SAGE`);
    expect(bills).toHaveLength(2);
    expect(bills.map(b => b.supplier_id)).toContain(other);
  });
  it('does not let a hand-captured bill with no Sage id absorb Sage invoices of another total', async () => {
    const tag = `K088M-${randomUUID().slice(0, 8)}`;
    const supplierId = (await pool.query<{ id: string }>(
      'SELECT id FROM suppliers WHERE company_id=$1 AND name=$2', [companyC, SUPPLIER_NAME])).rows[0]!.id;
    await pool.query(
      `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount, status, created_by)
       VALUES ($1, $2, $3, '2026-05-01', 9000, 9000, 'approved', $4)`, [companyC, `${tag}-RENT`, supplierId, user]);
    const m1 = await seedStaging(companyC, { sageId: `${tag}-M1`, invoiceNumber: `${tag}-RENT`, supplierName: SUPPLIER_NAME, total: 10000, invoiceDate: '2026-06-30' });
    const m2 = await seedStaging(companyC, { sageId: `${tag}-M2`, invoiceNumber: `${tag}-RENT`, supplierName: SUPPLIER_NAME, total: 10000, invoiceDate: '2026-07-31' });
    const result = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(result.skipped).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(2);
    const rows = (await pool.query('SELECT migration_status FROM sage_supplier_invoices WHERE id = ANY($1)', [[m1, m2]])).rows;
    expect(rows.map(r => r.migration_status)).toEqual(['failed', 'failed']);
    expect((await pool.query(
      'SELECT sage_invoice_id FROM supplier_invoices WHERE company_id=$1 AND invoice_number=$2', [companyC, `${tag}-RENT`])).rows[0]!.sage_invoice_id).toBeNull();
  });

  it('adopts a hand-captured bill of the same number and total once, then refuses the next Sage invoice under it', async () => {
    const tag = `K088A-${randomUUID().slice(0, 8)}`;
    const supplierId = (await pool.query<{ id: string }>(
      'SELECT id FROM suppliers WHERE company_id=$1 AND name=$2', [companyC, SUPPLIER_NAME])).rows[0]!.id;
    const manual = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount, status, created_by)
       VALUES ($1, $2, $3, '2026-05-01', 10000, 10000, 'approved', $4) RETURNING id`, [companyC, `${tag}-RENT`, supplierId, user])).rows[0]!.id;
    await seedStaging(companyC, { sageId: `${tag}-A1`, invoiceNumber: `${tag}-RENT`, supplierName: SUPPLIER_NAME, total: 10000, invoiceDate: '2026-06-30' });
    const a2 = await seedStaging(companyC, { sageId: `${tag}-A2`, invoiceNumber: `${tag}-RENT`, supplierName: SUPPLIER_NAME, total: 10000, invoiceDate: '2026-07-31' });
    const result = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    const bill = (await pool.query('SELECT sage_invoice_id FROM supplier_invoices WHERE id=$1', [manual])).rows[0]!;
    expect(bill.sage_invoice_id).toBe(`${tag}-A1`);
    expect((await pool.query('SELECT migration_status FROM sage_supplier_invoices WHERE id=$1', [a2])).rows[0]!.migration_status).toBe('failed');
  });

  it('fails, not links, a re-pended row whose total no longer matches the bill', async () => {
    const tag = `K088T-${randomUUID().slice(0, 8)}`;
    const stagingId = await seedStaging(companyC, { sageId: `${tag}-SAGE`, invoiceNumber: `${tag}-INV`, supplierName: SUPPLIER_NAME, total: 100 });
    await drive(companyC, () => importSupplierInvoices(companyC, user));
    await pool.query("UPDATE sage_supplier_invoices SET migration_status='pending', gl_supplier_invoice_id=NULL, total_amount=5000 WHERE id=$1", [stagingId]);
    const again = await drive(companyC, () => importSupplierInvoices(companyC, user));
    expect(again.failed).toBe(1);
    expect((await pool.query('SELECT migration_status FROM sage_supplier_invoices WHERE id=$1', [stagingId])).rows[0]!.migration_status).toBe('failed');
    expect((await billsFor(`${tag}-SAGE`)).length).toBe(1);
  });
  it('prefers the bill that already carries the Sage id over an older bill that only shares the number', async () => {
    const tag = `K088O-${randomUUID().slice(0, 8)}`;
    const supplierId = (await pool.query<{ id: string }>(
      'SELECT id FROM suppliers WHERE company_id=$1 AND name=$2', [companyC, SUPPLIER_NAME])).rows[0]!.id;
    const older = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount, status, created_by, created_at)
       VALUES ($1, $2, $3, '2026-05-01', 100, 100, 'approved', $4, NOW() - INTERVAL '1 day') RETURNING id`, [companyC, `${tag}-N2`, supplierId, user])).rows[0]!.id;
    const bySage = (await pool.query<{ id: string }>(
      `INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, total_amount, status, sage_invoice_id, created_by)
       VALUES ($1, $2, $3, '2026-05-02', 100, 100, 'approved', $5, $4) RETURNING id`, [companyC, `${tag}-N1`, supplierId, user, `${tag}-S1`])).rows[0]!.id;
    const stagingId = await seedStaging(companyC, { sageId: `${tag}-S1`, invoiceNumber: `${tag}-N2`, supplierName: SUPPLIER_NAME, total: 100 });
    await drive(companyC, () => importSupplierInvoices(companyC, user));
    const row = (await pool.query('SELECT gl_supplier_invoice_id FROM sage_supplier_invoices WHERE id=$1', [stagingId])).rows[0]!;
    expect(row.gl_supplier_invoice_id).toBe(bySage);
    expect((await pool.query('SELECT sage_invoice_id FROM supplier_invoices WHERE id=$1', [older])).rows[0]!.sage_invoice_id).toBeNull();
  });
});
