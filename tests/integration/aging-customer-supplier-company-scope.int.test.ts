// tests/integration/aging-customer-supplier-company-scope.int.test.ts
//
// Every JOIN from an aging document to its customer / supplier carries the
// document's company_id. customer_invoices.client_id/customer_id,
// credit_notes.client_id and supplier_invoices.supplier_id are plain FKs to the
// parent's id alone, so nothing at the schema level stops a row in company A
// pointing at company B's customer. Without `AND c.company_id = <doc>.company_id`
// on the join, company A's aging then prints company B's customer name (and
// buckets the invoice under B's entity id) — a cross-tenant read.
//
// Seeded here: in company A one legitimate document per side plus one document
// whose customer/supplier belongs to company B ("the poisoned row"). The poisoned
// row has a distinctive name so a leak is a string match, not an inference.
//
// Surfaces: getARAging / getAPAging (entity_name + bucket), the AP age-analysis
// route's per-invoice rows, and the credit-note read at its own exported
// function. Unallocated credit notes are pushed into getARAging with a NEGATIVE
// balance, which calculateAgingBuckets drops, so the credit-note join has no
// observable surface through the buckets: it is tested where it is exported.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { fetchUnallocatedCreditNotes } from '@/modules/accounting/services/ar/arAgingCreditNotes';
import { fetchARAgingInvoices, UNKNOWN_CUSTOMER } from '@/modules/accounting/services/ar/arAgingInvoices';
import { fetchAPAgingInvoices } from '@/modules/accounting/services/ap/apAgingInvoices';

// Auth and metering are not under test; the route's SQL is. The route reads
// companyId off the request, which the pass-through sets.
const routeCompany = vi.hoisted(() => ({ id: '' }));
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: (req: NextApiRequest, res: NextApiResponse) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) => {
      (req as unknown as { companyId: string }).companyId = routeCompany.id;
      return fn(req, res);
    },
}));
vi.mock('@/lib/billing/withFlowMeter', () => ({
  withFlowMeter: () => (fn: unknown) => fn,
}));
import apAgingRoute from '../../pages/api/accounting/reports-ap-aging';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const USER = randomUUID();
const CUST_A = randomUUID();
const CUST_B = randomUUID();
const SUPP_A = randomUUID();
const SUPP_B = randomUUID();
const TAG = `SCOPE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const LEAK_CUSTOMER = `Tenant B Customer ${TAG}`;
const LEAK_SUPPLIER = `Tenant B Supplier ${TAG}`;
const AS_AT = '2026-06-30';

describeIfDb('aging joins to customers/suppliers are scoped to the document company', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company, customer, supplier and invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    for (const [id, name] of [[A, 'Scope A'], [B, 'Scope B']] as const) {
      await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1,$2,true)`, [id, `${name} ${TAG}`]);
    }
    await admin.query(`INSERT INTO customers (id, company_id, name) VALUES ($1,$2,$3),($4,$5,$6)`,
      [CUST_A, A, `Tenant A Customer ${TAG}`, CUST_B, B, LEAK_CUSTOMER]);
    await admin.query(`INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,$3),($4,$5,$6)`,
      [SUPP_A, A, `Tenant A Supplier ${TAG}`, SUPP_B, B, LEAK_SUPPLIER]);

    // AR: one legitimate invoice (1000) and one pointing at company B's customer (777).
    await arInvoice(admin, 'OK', CUST_A, 1000);
    await arInvoice(admin, 'POISONED', CUST_B, 777);
    // Credit notes: unallocated, approved, one per customer.
    await creditNote(admin, 'OK', CUST_A, 100);
    await creditNote(admin, 'POISONED', CUST_B, 55);
    // AP: same shape.
    await apInvoice(admin, 'OK', SUPP_A, 2000);
    await apInvoice(admin, 'POISONED', SUPP_B, 888);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    for (const co of [A, B]) {
      await admin.query('DELETE FROM credit_notes WHERE company_id = $1', [co]);
      await admin.query('DELETE FROM customer_invoices WHERE company_id = $1', [co]);
      await admin.query('DELETE FROM supplier_invoices WHERE company_id = $1', [co]);
      await admin.query('DELETE FROM customers WHERE company_id = $1', [co]);
      await admin.query('DELETE FROM suppliers WHERE company_id = $1', [co]);
      await admin.query('DELETE FROM companies WHERE id = $1', [co]);
    }
    await admin.end();
  }, 60000);

  // Master's #915 made the open-invoice read a LEFT JOIN so Home's tile/donut
  // cannot drop an invoice the report's summary still counts. The scoped join
  // therefore no longer removes the poisoned invoice: it is KEPT (summary
  // parity) but company B's customer does not match, so it ages under
  // UNKNOWN_CUSTOMER. What must never happen is company B's NAME appearing.
  it('getARAging never names company B\'s customer; the poisoned invoice ages as unknown', async () => {
    const buckets = await getARAging(A, AS_AT);
    expect(buckets.map((b) => b.entityName)).not.toContain(LEAK_CUSTOMER);
    expect(JSON.stringify(buckets)).not.toContain(LEAK_CUSTOMER);
    const byName = Object.fromEntries(buckets.map((b) => [b.entityName, b.total]));
    expect(byName).toEqual({ [`Tenant A Customer ${TAG}`]: 1000, [UNKNOWN_CUSTOMER]: 777 });
  });

  it('the AR open-items read (drill-down / export source) carries no foreign customer name', async () => {
    const rows = await fetchARAgingInvoices(A, AS_AT, AS_AT);
    expect(rows.map((r) => r.entityName).sort()).toEqual([`Tenant A Customer ${TAG}`, UNKNOWN_CUSTOMER].sort());
    expect(JSON.stringify(rows)).not.toContain(LEAK_CUSTOMER);
  });

  it('the unallocated credit-note read returns only company A\'s customer', async () => {
    const rows = await fetchUnallocatedCreditNotes(A, AS_AT);
    expect(rows.map((r) => r.entityName)).toEqual([`Tenant A Customer ${TAG}`]);
    expect(rows.map((r) => r.balance)).toEqual([-100]);
  });

  it('getAPAging never names company B\'s supplier, and ages only the legitimate bill', async () => {
    const buckets = await getAPAging(A, AS_AT);
    expect(buckets.map((b) => b.entityName)).not.toContain(LEAK_SUPPLIER);
    expect(buckets.map((b) => [b.entityId, b.total])).toEqual([[SUPP_A, 2000]]);
  });

  it('the AP open-items read carries no foreign supplier', async () => {
    const rows = await fetchAPAgingInvoices(A, AS_AT, AS_AT);
    expect(rows.map((r) => r.entityName)).toEqual([`Tenant A Supplier ${TAG}`]);
  });

  it('the AP age-analysis route lists only the legitimate bill and never names company B\'s supplier', async () => {
    routeCompany.id = A;
    let status = 0;
    let body: unknown;
    const res = {
      status(code: number) { status = code; return this; },
      json(b: unknown) { body = b; return this; },
      setHeader() { return this; },
    } as unknown as NextApiResponse;
    const req = { method: 'GET', query: { as_at_date: AS_AT }, headers: {} } as unknown as NextApiRequest;
    await (apAgingRoute as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res);
    expect(status).toBe(200);
    const rows = (body as { data: { rows: { supplier_name: string; balance_due: number }[] } }).data.rows;
    expect(rows.map((r) => r.supplier_name)).toEqual([`Tenant A Supplier ${TAG}`]);
    expect(rows.map((r) => Number(r.balance_due))).toEqual([2000]);
  });
});

async function arInvoice(pool: Pool, tag: string, customer: string, total: number): Promise<void> {
  await pool.query(
    `INSERT INTO customer_invoices
       (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$2,$3,'2026-05-01','2026-05-31','approved',$4,0,$5)`,
    [A, customer, `${TAG}-AR-${tag}`, total, USER],
  );
}

async function creditNote(pool: Pool, tag: string, customer: string, total: number): Promise<void> {
  await pool.query(
    `INSERT INTO credit_notes
       (company_id, client_id, credit_note_number, credit_date, type, status, total_amount, applied_amount, created_by)
     VALUES ($1,$2,$3,'2026-05-15','customer','approved',$4,0,$5)`,
    [A, customer, `CN-${TAG.slice(-9)}-${tag}`, total, USER],
  );
}

async function apInvoice(pool: Pool, tag: string, supplier: string, total: number): Promise<void> {
  await pool.query(
    `INSERT INTO supplier_invoices
       (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$3,'2026-05-01','2026-05-31','approved',$4,0,$5)`,
    [A, supplier, `${TAG}-AP-${tag}`, total, USER],
  );
}
