/**
 * K-107 adjacent cases for the recurring-template numbering and the AP
 * uniqueness that was missing entirely.
 *
 * 1. Both entity types mint from the company sequence, and a second tenant
 *    running its own template neither sees nor moves the first tenant's counter.
 * 2. uq_supplier_invoices_supplier_number (migration 646) refuses a second bill
 *    with the same document number from the SAME supplier, and still allows two
 *    suppliers to issue the same number — invoice_number is the supplier's own
 *    number, not ours.
 * 3. A soft-deleted bill does not block re-capturing that number, which is what
 *    the partial predicate on the index is for.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { executeRecurring } from '../../src/modules/accounting/services/core/recurringTransactionService';
import { ensureDocumentNumbers } from '../../src/modules/accounting/services/core/companySettingsService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), other = crypto.randomUUID();
const user = crypto.randomUUID();
const customer = crypto.randomUUID();
const supplierA = crypto.randomUUID(), supplierB = crypto.randomUUID();
const otherCustomer = crypto.randomUUID();
const arTemplate = crypto.randomUUID(), apTemplate = crypto.randomUUID(), otherTemplate = crypto.randomUUID();

async function seedBill(id: string, supplier: string, number: string, deletedAt: string | null = null) {
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,subtotal,tax_amount,total_amount,created_by,deleted_at)
     VALUES($1,$2,$3,$4,'2026-01-01',100,15,115,$5,$6)`,
    [id, company, number, supplier, user, deletedAt]);
}

async function nextNumber(target: string, type: string): Promise<number> {
  const r = await pool.query(
    'SELECT next_number FROM company_document_numbers WHERE company_id=$1 AND document_type=$2',
    [target, type]);
  return Number(r.rows[0].next_number);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K107 adjacent', other, 'K107 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',
    [customer, company, 'K107 customer', otherCustomer, other, 'K107 other customer']);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$2,$5)',
    [supplierA, company, 'Supplier A', supplierB, 'Supplier B']);
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,created_by)
     VALUES($1,$2,'Weekly retainer','customer_invoice',$3,'weekly',$4)`,
    [arTemplate, company, JSON.stringify({ clientId: customer, subtotal: 100, vatAmount: 15, totalAmount: 115 }), user]);
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,created_by)
     VALUES($1,$2,'Weekly supply','supplier_invoice',$3,'weekly',$4)`,
    [apTemplate, company, JSON.stringify({ supplierId: supplierA, subtotal: 100, vatAmount: 15, totalAmount: 115 }), user]);
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,created_by)
     VALUES($1,$2,'Weekly retainer','customer_invoice',$3,'weekly',$4)`,
    [otherTemplate, other, JSON.stringify({ clientId: otherCustomer, subtotal: 100, vatAmount: 15, totalAmount: 115 }), user]);
  await ensureDocumentNumbers(company);
  await ensureDocumentNumbers(other);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM recurring_transaction_templates WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM suppliers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM customers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM company_document_numbers WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('mints both entity types from the company sequence and leaves the other tenant alone', async () => {
  // 'customer_invoice' — the SAME sequence every other writer of that table
  // uses. A dedicated 'recurring_invoice' type would leave the counter the
  // company settings screen shows failing to account for these invoices.
  const arBefore = await nextNumber(company, 'customer_invoice');
  const apBefore = await nextNumber(company, 'supplier_invoice');
  const otherBefore = await nextNumber(other, 'customer_invoice');

  await executeRecurring(company, arTemplate, user);
  await executeRecurring(company, arTemplate, user);
  await executeRecurring(company, apTemplate, user);
  await executeRecurring(other, otherTemplate, user);

  const ar = await pool.query(
    'SELECT invoice_number FROM customer_invoices WHERE company_id=$1 ORDER BY invoice_number', [company]);
  const ap = await pool.query(
    'SELECT invoice_number FROM supplier_invoices WHERE company_id=$1', [company]);

  expect.soft(ar.rows.map((r) => r.invoice_number)).toEqual([
    `INV${String(arBefore).padStart(7, '0')}`,
    `INV${String(arBefore + 1).padStart(7, '0')}`,
  ]);
  expect.soft(ap.rows.map((r) => r.invoice_number)).toEqual([`SIV${String(apBefore).padStart(7, '0')}`]);
  // The other tenant advanced only its own counter, by its own single run.
  expect.soft(await nextNumber(other, 'customer_invoice')).toBe(otherBefore + 1);
  expect(await nextNumber(company, 'customer_invoice')).toBe(arBefore + 2);
});

it('refuses a second bill with one supplier document number, and allows two suppliers to share one', async () => {
  await seedBill(crypto.randomUUID(), supplierA, 'VENDOR-77');

  const duplicate = await seedBill(crypto.randomUUID(), supplierA, 'VENDOR-77').then(
    () => 'accepted' as const,
    (err: unknown) => (err as { code?: string }).code ?? String(err),
  );
  expect.soft(duplicate).toBe('23505');

  const differentSupplier = await seedBill(crypto.randomUUID(), supplierB, 'VENDOR-77').then(
    () => 'accepted' as const,
    (err: unknown) => (err as { code?: string }).code ?? String(err),
  );
  expect(differentSupplier).toBe('accepted');
});

it('lets a soft-deleted bill number be captured again', async () => {
  await seedBill(crypto.randomUUID(), supplierA, 'VENDOR-88', '2026-02-01T00:00:00Z');

  const recaptured = await seedBill(crypto.randomUUID(), supplierA, 'VENDOR-88').then(
    () => 'accepted' as const,
    (err: unknown) => (err as { code?: string }).code ?? String(err),
  );
  expect(recaptured).toBe('accepted');
});
