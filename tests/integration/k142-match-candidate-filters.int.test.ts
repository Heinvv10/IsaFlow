/**
 * K-142 (review L-4, L-5) — what the bank-match candidate queries are allowed
 * to offer.
 *
 * L-4: `supplier_invoices` and `customer_invoices` both carry `deleted_at`, and
 * neither candidate query excluded soft-deleted rows — so a bill the user had
 * deleted was still offered as something to pay a bank line against.
 *
 * L-5: the purchase-order arm filtered on `po.status IN ('approved',
 * 'partially_paid')`, but `purchase_orders_status_check` allows only
 * draft/submitted/approved/partially_received/received/cancelled. The
 * 'partially_paid' literal was dead, and 'partially_received' — the status a
 * part-delivered PO actually holds — was never offered at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import {
  fetchSupplierInvoiceCandidates,
  fetchCustomerInvoiceCandidates,
  fetchPurchaseOrderCandidates,
} from '@/modules/accounting/services/bank/bankMatchDbQueries';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();

let admin: Pool;
let supplier = '';
let customer = '';

async function run<T>(fn: () => Promise<T>): Promise<T> {
  const c: PoolClient = await admin.connect();
  try {
    return await als.run({ client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn);
  } finally {
    c.release();
  }
}

describeIfDb('K-142 bank-match candidates: soft-deleted rows and PO statuses', () => {
  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await admin.query(
      `INSERT INTO companies (id,name,is_active) VALUES ($1,'K142 Candidate Fixture',true)`, [COMPANY]);
    const s = await admin.query(
      `INSERT INTO suppliers (company_id, name) VALUES ($1,'K142 Supplier') RETURNING id`, [COMPANY]);
    supplier = s.rows[0].id;
    const c = await admin.query(
      `INSERT INTO customers (company_id, name) VALUES ($1,'K142 Customer') RETURNING id`, [COMPANY]);
    customer = c.rows[0].id;

    await admin.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, total_amount, amount_paid, status, created_by, deleted_at)
       VALUES ($1,$2,'K142-LIVE','2026-03-01',1000,0,'approved',$3,NULL),
              ($1,$2,'K142-DELETED','2026-03-01',1000,0,'approved',$3,NOW())`,
      [COMPANY, supplier, USER]);

    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, customer_id, invoice_number, invoice_date, total_amount, amount_paid, status, created_by, deleted_at)
       VALUES ($1,$2,'K142-CI-LIVE','2026-03-01',1000,0,'sent',$3,NULL),
              ($1,$2,'K142-CI-DELETED','2026-03-01',1000,0,'sent',$3,NOW())`,
      [COMPANY, customer, USER]);

    await admin.query(
      `INSERT INTO purchase_orders (company_id, supplier_id, po_number, total, status)
       VALUES ($1,$2,'K142-PO-APPROVED',1000,'approved'),
              ($1,$2,'K142-PO-PARTRECD',1000,'partially_received'),
              ($1,$2,'K142-PO-CANCELLED',1000,'cancelled')`,
      [COMPANY, supplier]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM purchase_orders WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM supplier_invoices WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM customer_invoices WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM suppliers WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);
    await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
    await admin.end();
  });

  it('never offers a soft-deleted supplier invoice', async () => {
    const c = await run(() => fetchSupplierInvoiceCandidates(COMPANY, 1000, -1000, '2026-03-01', '', '', []));
    const labels = c.map(x => x.label).join(' | ');
    expect(labels).toContain('K142-LIVE');
    expect(labels).not.toContain('K142-DELETED');
  }, 60000);

  it('never offers a soft-deleted customer invoice', async () => {
    const c = await run(() => fetchCustomerInvoiceCandidates(COMPANY, 1000, 1000, '2026-03-01', '', '', []));
    const labels = c.map(x => x.label).join(' | ');
    expect(labels).toContain('K142-CI-LIVE');
    expect(labels).not.toContain('K142-CI-DELETED');
  }, 60000);

  it('offers a part-delivered PO and still excludes a cancelled one', async () => {
    const c = await run(() => fetchPurchaseOrderCandidates(COMPANY, 1000, -1000, '2026-03-01', '', '', []));
    const labels = c.map(x => x.label).join(' | ');
    expect(labels).toContain('K142-PO-APPROVED');
    expect(labels).toContain('K142-PO-PARTRECD');
    expect(labels).not.toContain('K142-PO-CANCELLED');
  }, 60000);
});
