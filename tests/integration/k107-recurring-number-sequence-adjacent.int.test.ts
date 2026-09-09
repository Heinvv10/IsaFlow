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
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
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

/**
 * Run inside a real request transaction, exactly as withAuth does. The service
 * now takes FOR UPDATE on the template and refuses without one, because outside
 * a transaction that lock is released the instant the SELECT returns.
 */
async function inTx<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  const ctx = { client, userId: user, companyId: target, claims: {} } as unknown as Parameters<typeof als.run>[0];
  try {
    await client.query('BEGIN');
    const out = await als.run(ctx, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The next run date arriving, without waiting a week for it. */
async function makeDue(target: string, templateId: string) {
  await pool.query(
    'UPDATE recurring_transaction_templates SET next_run_date = CURRENT_DATE WHERE id=$1 AND company_id=$2',
    [templateId, target]);
}

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
    await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id=ANY($1))', [[company, other]]);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=ANY($1))', [[company, other]]);
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

  await inTx(company, () => executeRecurring(company, arTemplate, user));
  // The second AR run is a genuinely due one a week later, not a double-click:
  // the schedule guard refuses a repeat while next_run_date is still ahead.
  await makeDue(company, arTemplate);
  await inTx(company, () => executeRecurring(company, arTemplate, user));
  await inTx(company, () => executeRecurring(company, apTemplate, user));
  await inTx(other, () => executeRecurring(other, otherTemplate, user));

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

/**
 * Line items. `executeRecurring` used to mint a bare header — a receivable in
 * AR, a payable in AP, with no detail behind it — and those headers now consume
 * the main INV/SIV sequence alongside real documents. A template that carries
 * `lines` writes them, and what it writes must FOOT against the header it was
 * posted from. Templates that predate the field carry only the aggregate and
 * must still run, so an absent `lines` array is not an error.
 */
const linedAr = crypto.randomUUID(), linedAp = crypto.randomUUID();
const LINES = [
  { description: 'Retainer hours', quantity: 2, unitPrice: 100, taxRate: 15, lineTotal: 200 },
  { description: 'Support', quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100 },
];

it('writes lines that foot against the AR header, and still runs a template with none', async () => {
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,created_by)
     VALUES($1,$2,'Lined retainer','customer_invoice',$3,'weekly',$4)`,
    [linedAr, company, JSON.stringify({
      clientId: customer, subtotal: 300, vatAmount: 45, totalAmount: 345, lines: LINES,
    }), user]);

  const run = await inTx(company, () => executeRecurring(company, linedAr, user));
  const foot = await pool.query(
    `SELECT ci.subtotal::numeric AS header_subtotal, ci.tax_amount::numeric AS header_tax,
            ci.total_amount::numeric AS header_total,
            COALESCE(sum(it.amount),0)::numeric AS line_subtotal,
            COALESCE(sum(it.amount * it.tax_rate / 100),0)::numeric AS line_tax,
            count(it.id)::int AS n
       FROM customer_invoices ci
       LEFT JOIN customer_invoice_items it ON it.invoice_id = ci.id
      WHERE ci.id=$1 AND ci.company_id=$2
      GROUP BY ci.id, ci.subtotal, ci.tax_amount, ci.total_amount`,
    [run.entityId, company]);
  const r = foot.rows[0];
  expect.soft(r.n).toBe(2);
  expect.soft(Number(r.line_subtotal)).toBeCloseTo(Number(r.header_subtotal), 2);
  expect.soft(Number(r.line_tax)).toBeCloseTo(Number(r.header_tax), 2);
  expect.soft(Number(r.header_total)).toBeCloseTo(Number(r.header_subtotal) + Number(r.header_tax), 2);

  // The pre-`lines` template shape: aggregate only, and it must still run.
  await makeDue(company, arTemplate);
  const legacy = await inTx(company, () => executeRecurring(company, arTemplate, user));
  const legacyLines = await pool.query(
    'SELECT count(*)::int AS n FROM customer_invoice_items WHERE invoice_id=$1', [legacy.entityId]);
  expect(legacyLines.rows[0].n).toBe(0);
});

it('writes lines that foot against the AP header', async () => {
  await pool.query(
    `INSERT INTO recurring_transaction_templates(id,company_id,name,entity_type,template_data,frequency,created_by)
     VALUES($1,$2,'Lined supply','supplier_invoice',$3,'weekly',$4)`,
    [linedAp, company, JSON.stringify({
      supplierId: supplierA, subtotal: 300, vatAmount: 45, totalAmount: 345, lines: LINES,
    }), user]);

  const run = await inTx(company, () => executeRecurring(company, linedAp, user));
  const foot = await pool.query(
    `SELECT si.subtotal::numeric AS header_subtotal, si.tax_amount::numeric AS header_tax,
            si.total_amount::numeric AS header_total,
            COALESCE(sum(it.line_total),0)::numeric AS line_subtotal,
            COALESCE(sum(it.tax_amount),0)::numeric AS line_tax,
            count(it.id)::int AS n
       FROM supplier_invoices si
       LEFT JOIN supplier_invoice_items it ON it.supplier_invoice_id = si.id
      WHERE si.id=$1 AND si.company_id=$2
      GROUP BY si.id, si.subtotal, si.tax_amount, si.total_amount`,
    [run.entityId, company]);
  const r = foot.rows[0];
  expect.soft(r.n).toBe(2);
  expect.soft(Number(r.line_subtotal)).toBeCloseTo(Number(r.header_subtotal), 2);
  expect.soft(Number(r.line_tax)).toBeCloseTo(Number(r.header_tax), 2);
  expect(Number(r.header_total)).toBeCloseTo(Number(r.header_subtotal) + Number(r.header_tax), 2);
});
