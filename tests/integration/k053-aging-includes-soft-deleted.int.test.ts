/**
 * K-053 — RED. Neither aging service filters the soft-delete flag.
 *
 * `customer_invoices.deleted_at` and `supplier_invoices.deleted_at` are set by
 * softDeleteService (mig 268) and are the ONLY record that a document was
 * deleted — `purgeExpiredDeletes` (softDeleteService.ts:256) has no caller
 * anywhere in src/ or pages/, so the "5-minute undo window" never expires and
 * a soft-deleted row is permanent.
 *
 * `getARAging` (arAgingService.ts:47-56) and `getAPAging`
 * (apAgingService.ts:82-88) filter company, status and date, but not
 * deleted_at — so a deleted invoice keeps aging, keeps appearing in the
 * overdue book, and keeps being chased.
 *
 * The soft-delete guard only blocks status='posted' (softDeleteService.ts:199),
 * while aging only excludes 'draft' and 'cancelled' — so every 'approved',
 * 'sent', 'partially_paid' and 'overdue' invoice is both deletable AND aged.
 *
 * Expected on a fixed build: the deleted invoice is absent from both reports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `K053-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const AS_AT = '2026-06-30';

const LIVE = 1000;
const DELETED = 750;

let customer: string;
let supplier: string;

describeIfDb('K-053 aging reports keep aging soft-deleted invoices', () => {
  beforeAll(async () => {
    await sql`INSERT INTO companies (id, name, registration_number, created_at)
              VALUES (${COMPANY}::UUID, ${'K053 ' + TAG}, ${TAG}, NOW())`;
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'K053 cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'K053 supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    // One live invoice and one soft-deleted invoice per side. Both 'approved',
    // both overdue at the as-at date, both with a balance.
    await sql`
      INSERT INTO customer_invoices
        (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by, deleted_at)
      VALUES
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-LIVE'}, '2026-01-15', '2026-02-15', 'approved', ${LIVE}, 0, ${USER}::UUID, NULL),
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-AR-DEL'},  '2026-01-15', '2026-02-15', 'approved', ${DELETED}, 0, ${USER}::UUID, NOW())`;

    await sql`
      INSERT INTO supplier_invoices
        (company_id, supplier_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by, deleted_at)
      VALUES
        (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-LIVE'}, '2026-01-15', '2026-02-15', 'approved', ${LIVE}, 0, ${USER}::UUID, NULL),
        (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-AP-DEL'},  '2026-01-15', '2026-02-15', 'approved', ${DELETED}, 0, ${USER}::UUID, NOW())`;
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 60000);

  it('AR aging excludes the soft-deleted invoice', async () => {
    const buckets = await getARAging(COMPANY, AS_AT);
    const row = buckets.find((b) => b.entityId === customer);
    expect(row).toBeDefined();
    // R1,750 today: the deleted R750 is still being chased.
    expect(row!.total).toBeCloseTo(LIVE, 2);
  });

  it('AP aging excludes the soft-deleted bill', async () => {
    const buckets = await getAPAging(COMPANY, AS_AT);
    const row = buckets.find((b) => b.entityId === supplier);
    expect(row).toBeDefined();
    expect(row!.total).toBeCloseTo(LIVE, 2);
  });
});
