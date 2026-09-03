// tests/integration/aging-point-in-time.int.test.ts
//
// `asAtDate` was decorative. Both aging services read `amount_paid`, which is a
// CURRENT snapshot, and filtered on the CURRENT outstanding balance — so an
// as-at date only re-bucketed today's balances by age. Two consequences:
//
//   * An invoice settled after the as-at date showed as already paid down on a
//     date when it was still fully outstanding.
//   * An invoice settled in full since then vanished from the historical
//     report altogether, because the `balance > 0` filter is applied to
//     today's figure.
//
// monthEndWorkbenchService calls getARAging/getAPAging with a historical
// periodEnd (`monthEndWorkbenchService.ts:108,122`), and the MCP reports tools
// expose `as_at`, so this is a live parameter, not a hypothetical.
//
// Settlement history is complete enough to reconstruct: every customer_payments
// and supplier_payments row carries a payment_date (zero nulls in production),
// and for real client companies the allocations reconcile to `amount_paid`
// exactly — the only divergence is in the demo company's seeded data.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-00000000e1a1';
const CUSTOMER = '00000000-0000-0000-0000-00000000e1a2';
const SUPPLIER = '00000000-0000-0000-0000-00000000e1a3';
const BANK = '00000000-0000-0000-0000-00000000e1a4';

// Before any payment lands.
const EARLY = '2026-03-31';
// After every payment has landed.
const LATE = '2026-09-30';

const AR_PARTLY = 1000;   // invoiced Jan, 400 paid in May
const AR_PART_PAID = 400;
const AR_SETTLED = 800;   // invoiced Feb, settled in full in July
const AR_FUTURE = 500;    // invoiced Aug — not yet issued at EARLY
// Invoiced Feb, then partly CREDITED in June. Approving a credit note raises
// amount_paid and writes no allocation row, so a reconstruction that reads
// allocations alone leaves this invoice looking fully outstanding forever.
const AR_CREDITED = 900;
const AR_CREDIT_NOTE = 300;

const AP_PARTLY = 2000;
const AP_PART_PAID = 750;
// Settled in full in July, so its generated `balance` column is 0 today. Only
// a point-in-time balance brings it back for a March report.
const AP_SETTLED = 600;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('aging as at a past date reflects that date, not today', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'Point In Time Fixture',true)
       ON CONFLICT (id) DO NOTHING`, [COMPANY]);
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1,$2,'PIT Customer')
       ON CONFLICT (id) DO NOTHING`, [CUSTOMER, COMPANY]);
    await admin.query(
      `INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,'PIT Supplier')
       ON CONFLICT (id) DO NOTHING`, [SUPPLIER, COMPANY]);
    await admin.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES ($1,$2,'PI1000','Bank','asset','bank','debit',true) ON CONFLICT (id) DO NOTHING`,
      [BANK, COMPANY]);

    // ── AR ────────────────────────────────────────────────────────────────
    const arPartly = await insertCustomerInvoice(admin, 'PIT-AR-1', '2026-01-15', '2026-02-15', AR_PARTLY, AR_PART_PAID, 'partially_paid');
    const arSettled = await insertCustomerInvoice(admin, 'PIT-AR-2', '2026-02-01', '2026-03-01', AR_SETTLED, AR_SETTLED, 'paid');
    await insertCustomerInvoice(admin, 'PIT-AR-3', '2026-08-01', '2026-09-01', AR_FUTURE, 0, 'approved');

    const arCredited = await insertCustomerInvoice(admin, 'PIT-AR-4', '2026-02-10', '2026-03-10', AR_CREDITED, AR_CREDIT_NOTE, 'partially_paid');
    await admin.query(
      `INSERT INTO credit_notes
         (company_id, client_id, customer_invoice_id, credit_note_number, credit_date, type, status, total_amount, created_by)
       VALUES ($1,$2,$3,'PIT-CN1','2026-06-01','customer','applied',$4,$5)`,
      [COMPANY, CUSTOMER, arCredited, AR_CREDIT_NOTE, COMPANY],
    );

    await payCustomer(admin, 'PIT-R1', '2026-05-10', AR_PART_PAID, arPartly);
    await payCustomer(admin, 'PIT-R2', '2026-07-01', AR_SETTLED, arSettled);

    // ── AP ────────────────────────────────────────────────────────────────
    const apPartly = await insertSupplierInvoice(admin, 'PIT-AP-1', '2026-01-20', '2026-02-20', AP_PARTLY, AP_PART_PAID, 'partially_paid');
    await paySupplier(admin, 'PIT-P1', '2026-06-05', AP_PART_PAID, apPartly);

    const apSettled = await insertSupplierInvoice(admin, 'PIT-AP-2', '2026-01-25', '2026-02-25', AP_SETTLED, AP_SETTLED, 'paid');
    await paySupplier(admin, 'PIT-P2', '2026-07-15', AP_SETTLED, apSettled);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('AR: an invoice is fully outstanding before its payment lands', async () => {
    const early = await getARAging(COMPANY, EARLY);
    const customer = early.find((b) => b.entityId === CUSTOMER)!;

    // On 31 March, neither the May payment nor the July one had happened, so
    // both invoices were open in full. The old behaviour showed 600 + 0.
    expect(customer.total).toBeCloseTo(AR_PARTLY + AR_SETTLED + AR_CREDITED, 2);
  });

  it('AR: a since-settled invoice still appears on a date when it was open', async () => {
    const early = await getARAging(COMPANY, EARLY);
    const customer = early.find((b) => b.entityId === CUSTOMER)!;

    // PIT-AR-2 is `paid` today, so filtering on the CURRENT balance dropped it
    // from the historical report entirely.
    expect(customer.total).toBeGreaterThanOrEqual(AR_SETTLED);
  });

  it('AR: an invoice not yet issued is absent', async () => {
    const early = await getARAging(COMPANY, EARLY);
    const late = await getARAging(COMPANY, LATE);

    const earlyTotal = early.find((b) => b.entityId === CUSTOMER)!.total;
    const lateTotal = late.find((b) => b.entityId === CUSTOMER)?.total ?? 0;

    // PIT-AR-3 is dated August: in at LATE, out at EARLY.
    expect(earlyTotal).toBeCloseTo(AR_PARTLY + AR_SETTLED + AR_CREDITED, 2);
    expect(lateTotal).toBeCloseTo(
      (AR_PARTLY - AR_PART_PAID) + AR_FUTURE + (AR_CREDITED - AR_CREDIT_NOTE), 2);
  });

  it('AP: an invoice is fully outstanding before its payment lands', async () => {
    const early = await getAPAging(COMPANY, EARLY);
    const supplier = early.find((b) => b.entityId === SUPPLIER)!;

    // Includes PIT-AP-2, whose generated `balance` column is 0 today: reading
    // that column erased it from every historical report.
    expect(supplier.total).toBeCloseTo(AP_PARTLY + AP_SETTLED, 2);
  });

  it('AP: the same invoice is net of the payment afterwards', async () => {
    const late = await getAPAging(COMPANY, LATE);
    const supplier = late.find((b) => b.entityId === SUPPLIER)!;

    expect(supplier.total).toBeCloseTo(AP_PARTLY - AP_PART_PAID, 2);
  });

  it('AR: a credit note reduces the debt from its credit date, not before', async () => {
    const early = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!;
    const late = (await getARAging(COMPANY, LATE)).find((b) => b.entityId === CUSTOMER)!;

    // The credit note is dated June. Nothing settles PIT-AR-4 through an
    // allocation row, so reading allocations alone would report the full 900
    // at BOTH dates.
    expect(early.total).toBeCloseTo(AR_PARTLY + AR_SETTLED + AR_CREDITED, 2);
    expect(late.total).toBeCloseTo(
      (AR_PARTLY - AR_PART_PAID) + AR_FUTURE + (AR_CREDITED - AR_CREDIT_NOTE), 2);
  });

  it('the as-at date changes the answer at all', async () => {
    // The whole point: two dates, two different books. Before this, both
    // returned today's balances re-bucketed.
    const arEarly = (await getARAging(COMPANY, EARLY)).find((b) => b.entityId === CUSTOMER)!.total;
    const arLate = (await getARAging(COMPANY, LATE)).find((b) => b.entityId === CUSTOMER)!.total;
    expect(arEarly).not.toBeCloseTo(arLate, 2);
  });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

async function insertCustomerInvoice(
  admin: Pool, number: string, invoiceDate: string, dueDate: string,
  total: number, paid: number, status: string,
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO customer_invoices
       (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [COMPANY, CUSTOMER, number, invoiceDate, dueDate, status, total, paid, COMPANY],
  );
  return rows[0].id as string;
}

async function insertSupplierInvoice(
  admin: Pool, number: string, invoiceDate: string, dueDate: string,
  total: number, paid: number, status: string,
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO supplier_invoices
       (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [COMPANY, SUPPLIER, number, invoiceDate, dueDate, status, total, paid, COMPANY],
  );
  return rows[0].id as string;
}

async function payCustomer(
  admin: Pool, number: string, date: string, amount: number, invoiceId: string,
): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO customer_payments
       (company_id, client_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7) RETURNING id`,
    [COMPANY, CUSTOMER, number, date, amount, BANK, COMPANY],
  );
  await admin.query(
    `INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
     VALUES ($1,$2,$3)`,
    [rows[0].id, invoiceId, amount],
  );
}

async function paySupplier(
  admin: Pool, number: string, date: string, amount: number, invoiceId: string,
): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO supplier_payments
       (company_id, supplier_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,'processed',$6,$7) RETURNING id`,
    [COMPANY, SUPPLIER, number, date, amount, BANK, COMPANY],
  );
  await admin.query(
    `INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
     VALUES ($1,$2,$3)`,
    [rows[0].id, invoiceId, amount],
  );
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query(`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = $1)`, [COMPANY]);
  await admin.query(`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = $1)`, [COMPANY]);
  await admin.query('DELETE FROM credit_notes WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customer_payments WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM supplier_payments WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customer_invoices WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM supplier_invoices WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM suppliers WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
