// tests/integration/ar-ap-aging-undated.int.test.ts
//
// An aging report's cardinal sin is omission: a debt left off the report is a
// debt nobody chases and nobody provides for.
//
// Both aging services filtered `due_date IS NOT NULL`. An invoice with no due
// date was not shown in a bucket, not counted in a total, and not reported as
// excluded — it simply was not in the report. In production that is:
//
//   AR   34 invoices    R13,908,380.43
//   AP  357 invoices    R37,703,816.94   — 33% of all open payables
//
// Every one of those rows has an invoice_date, so the debt exists and its age
// is knowable. They are now aged from the invoice date and flagged, rather
// than dropped.
//
// These tests seed an invoice with no due date and assert it reaches the
// report. They assert the money, not the SQL.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getARAging, getARAgingDetail } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging, getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-0000000000a1';
const CUSTOMER = '00000000-0000-0000-0000-0000000000a2';
const SUPPLIER = '00000000-0000-0000-0000-0000000000a3';

const AS_AT = '2026-06-30';

// Dated invoices, comfortably overdue at the as-at date.
const AR_DATED = 1000;
const AP_DATED = 2000;
// Undated invoices — the money that used to vanish.
const AR_UNDATED = 750;
const AP_UNDATED = 1500;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('aging reports include invoices with no due date', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'Aging Fixture', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY],
    );
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Aging Customer')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER, COMPANY],
    );
    await admin.query(
      `INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, 'Aging Supplier')
       ON CONFLICT (id) DO NOTHING`,
      [SUPPLIER, COMPANY],
    );

    await admin.query(
      // Both client_id and customer_id exist on this table; customer_id is
      // NOT NULL and reads go through COALESCE(client_id, customer_id).
      `INSERT INTO customer_invoices
         (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
       VALUES
         ($1, $2, $2, 'AGE-AR-1', '2026-01-15', '2026-02-15', 'approved', $3, 0, $5),
         ($1, $2, $2, 'AGE-AR-2', '2026-01-20', NULL,         'approved', $4, 0, $5)`,
      [COMPANY, CUSTOMER, AR_DATED, AR_UNDATED, COMPANY],
    );

    await admin.query(
      `INSERT INTO supplier_invoices
         (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
       VALUES
         ($1, $2, 'AGE-AP-1', '2026-01-15', '2026-02-15', 'approved', $3, 0, $5),
         ($1, $2, 'AGE-AP-2', '2026-01-20', NULL,         'approved', $4, 0, $5)`,
      [COMPANY, SUPPLIER, AP_DATED, AP_UNDATED, COMPANY],
    );
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('AR aging reports the undated invoice', async () => {
    const buckets = await getARAging(COMPANY, AS_AT);
    const customer = buckets.find((b) => b.entityId === CUSTOMER);

    expect(customer).toBeDefined();
    // R750 used to be missing entirely.
    expect(customer!.total).toBeCloseTo(AR_DATED + AR_UNDATED, 2);
  });

  it('AP aging reports the undated invoice', async () => {
    const buckets = await getAPAging(COMPANY, AS_AT);
    const supplier = buckets.find((b) => b.entityId === SUPPLIER);

    expect(supplier).toBeDefined();
    expect(supplier!.total).toBeCloseTo(AP_DATED + AP_UNDATED, 2);
  });

  it('ages an undated invoice from its invoice date, not as current', async () => {
    const buckets = await getAPAging(COMPANY, AS_AT);
    const supplier = buckets.find((b) => b.entityId === SUPPLIER)!;

    // Invoiced 2026-01-20, as at 2026-06-30 — over 120 days. Treating a
    // missing due date as "not yet due" would park real debt in `current`
    // and understate the overdue book.
    expect(supplier.current).toBeCloseTo(0, 2);
    expect(supplier.days120Plus).toBeCloseTo(AP_DATED + AP_UNDATED, 2);
  });

  it('the AP drill-down agrees with the AP summary for the same supplier', async () => {
    // The summary and the detail are two queries over the same population. If
    // only one of them is fixed, the drill-down contradicts the total it drills
    // into — which reads as a reconciled figure and is worse than the original
    // omission.
    const summary = await getAPAging(COMPANY, AS_AT);
    const detail = await getAPAgingDetail(COMPANY, SUPPLIER, AS_AT);

    const supplierTotal = summary.find((b) => b.entityId === SUPPLIER)!.total;
    expect(detail.buckets?.total).toBeCloseTo(supplierTotal, 2);
    expect(detail.invoices).toHaveLength(2);
  });

  it('the AR drill-down agrees with the AR summary for the same customer', async () => {
    const summary = await getARAging(COMPANY, AS_AT);
    const detail = await getARAgingDetail(COMPANY, CUSTOMER, AS_AT);

    const customerTotal = summary.find((b) => b.entityId === CUSTOMER)!.total;
    expect(detail.buckets?.total).toBeCloseTo(customerTotal, 2);
    expect(detail.invoices).toHaveLength(2);
  });

  it('flags a derived due date rather than presenting it as recorded', async () => {
    const detail = await getAPAgingDetail(COMPANY, SUPPLIER, AS_AT);

    const undated = detail.invoices.find((i) => i.id !== undefined && i.dueDateMissing === true);
    expect(undated).toBeDefined();
    expect(detail.invoices.filter((i) => i.dueDateMissing === true)).toHaveLength(1);
  });

  it('the totals still foot to the sum of the buckets', async () => {
    for (const buckets of [await getARAging(COMPANY, AS_AT), await getAPAging(COMPANY, AS_AT)]) {
      for (const b of buckets) {
        const summed = b.current + b.days30 + b.days60 + b.days90 + b.days120Plus;
        // `total` is already net of disputed (see AgingBucket), so the buckets
        // sum to it directly. Adding `disputed` to BOTH sides — as this once
        // did — cancels out and asserts nothing about disputed handling.
        expect(summed).toBeCloseTo(b.total, 2);
      }
    }
  });
});

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM customer_invoices WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM supplier_invoices WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM suppliers WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
