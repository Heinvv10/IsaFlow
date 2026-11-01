// tests/integration/aging-customer-supplier-company-scope.int.test.ts
//
// Every JOIN from an aging document to its customer / supplier carries the
// document's company_id. customer_invoices.client_id/customer_id,
// credit_notes.client_id and supplier_invoices.supplier_id are not tied to the
// document's company at the schema level, so a row in company A can point at
// company B's customer/supplier. Without `AND c.company_id = <doc>.company_id`
// on the join, company A's aging prints company B's name (a cross-tenant read).
//
// The joins are LEFT (master's #915, and the AP side mirrors it): the report's
// summary reads the document table alone, so an inner join would drop the
// poisoned document from the list/tile while the summary still counts it. The
// document therefore STAYS in every total, ages under UNKNOWN_CUSTOMER /
// UNKNOWN_SUPPLIER, and company B's name and B's own documents never appear.
//
// Fixture: tests/helpers/agingScopeFixture.ts (tenant B has its own invoice,
// bill and credit note too). Surfaces here: getARAging / getAPAging, the
// open-items reads, the AP age-analysis route (rows AND summary), and the
// credit-note read at its own exported function (unallocated credit notes are
// pushed into getARAging with a NEGATIVE balance, which calculateAgingBuckets
// drops, so that join has no surface through the buckets). Drill-downs:
// aging-customer-supplier-company-scope-detail.int.test.ts.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { AMOUNTS, dropAgingScope, newAgingScope, seedAgingScope } from '../helpers/agingScopeFixture';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { fetchUnallocatedCreditNotes } from '@/modules/accounting/services/ar/arAgingCreditNotes';
import { fetchARAgingInvoices, UNKNOWN_CUSTOMER } from '@/modules/accounting/services/ar/arAgingInvoices';
import { fetchAPAgingInvoices, UNKNOWN_SUPPLIER } from '@/modules/accounting/services/ap/apAgingInvoices';
import { getOpenBook } from '@/modules/accounting/services/reports/dashboardOpenBook';
import { buildOpenItems } from '@/modules/accounting/services/reports/openItemsExport';

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

const S = newAgingScope();
const AS_AT = '2026-06-30';
const AR_TOTAL = AMOUNTS.arOk + AMOUNTS.arPoisoned; // 1777
const AP_TOTAL = AMOUNTS.apOk + AMOUNTS.apPoisoned; // 2888

/** Tenant B's own amounts as JSON numbers (a name match alone would miss an amount leak). */
function mentionsTenantBAmount(json: string): boolean {
  return new RegExp(`[:,\\[](${AMOUNTS.arB}|${AMOUNTS.apB}|${AMOUNTS.cnB})(\\.0+)?[,}\\]]`).test(json);
}

async function callApRoute(): Promise<{ status: number; data: ApRouteData }> {
  routeCompany.id = S.A;
  let status = 0;
  let body: unknown;
  const res = {
    status(code: number) { status = code; return this; },
    json(b: unknown) { body = b; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  const req = { method: 'GET', query: { as_at_date: AS_AT }, headers: {} } as unknown as NextApiRequest;
  await (apAgingRoute as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res);
  return { status, data: (body as { data: ApRouteData }).data };
}

interface ApRouteData {
  rows: { supplier_name: string; balance_due: number }[];
  summary: { bucket: string; count: number; total: number }[];
}

describeIfDb('aging joins to customers/suppliers are scoped to the document company', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company, customer, supplier and invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await seedAgingScope(admin, S);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await dropAgingScope(admin, S);
    await admin.end();
  }, 60000);

  // The poisoned invoice is KEPT (summary parity) but company B's customer does
  // not match, so it ages under UNKNOWN_CUSTOMER with A's stored id.
  it('getARAging totals exactly A\'s invoices; the poisoned one ages as unknown, B\'s name and own invoice never appear', async () => {
    const buckets = await getARAging(S.A, AS_AT);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => [b.entityId, b.entityName, b.total]).sort()).toEqual([
      [S.CUST_A, `Tenant A Customer ${S.TAG}`, AMOUNTS.arOk],
      [S.CUST_B, UNKNOWN_CUSTOMER, AMOUNTS.arPoisoned],
    ].sort());
    expect(buckets.reduce((t, b) => t + b.total, 0)).toBe(AR_TOTAL);
    const json = JSON.stringify(buckets);
    expect(json).not.toContain(S.LEAK_CUSTOMER);
    expect(mentionsTenantBAmount(json)).toBe(false);
  });

  it('the AR open-items read carries no foreign customer name and none of B\'s invoices', async () => {
    const rows = await fetchARAgingInvoices(S.A, AS_AT, AS_AT);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.entityName).sort()).toEqual([`Tenant A Customer ${S.TAG}`, UNKNOWN_CUSTOMER].sort());
    expect(rows.map((r) => r.balance).sort((a, b) => a - b)).toEqual([AMOUNTS.arPoisoned, AMOUNTS.arOk]);
    expect(JSON.stringify(rows)).not.toContain(S.LEAK_CUSTOMER);
  });

  it('the unallocated credit-note read keeps A\'s notes, the foreign customer\'s under UNKNOWN_CUSTOMER, and none of B\'s', async () => {
    const number = `CN-${S.TAG.slice(-9)}-NO-PARTY`;
    await admin.query(`INSERT INTO credit_notes (company_id, credit_note_number, credit_date, type, status, total_amount, applied_amount, created_by)
      VALUES ($1,$2,'2026-05-15','customer','approved',7,0,$3)`, [S.A, number, S.USER]);
    try {
      const rows = await fetchUnallocatedCreditNotes(S.A, AS_AT);
      const sorted = rows.map((r) => [r.entityId, r.entityName, r.balance]).sort();
      expect(sorted).toEqual([
        [S.CUST_A, `Tenant A Customer ${S.TAG}`, -AMOUNTS.cnOk],
        [S.CUST_B, UNKNOWN_CUSTOMER, -AMOUNTS.cnPoisoned],
      ].sort());
      expect(JSON.stringify(rows)).not.toContain(S.LEAK_CUSTOMER);
    } finally {
      await admin.query('DELETE FROM credit_notes WHERE company_id = $1 AND credit_note_number = $2', [S.A, number]);
    }
  });

  // AP mirrors AR: the foreign-supplier bill stays in the total as unknown.
  it('getAPAging totals exactly A\'s bills; the foreign-supplier bill ages as unknown, B\'s name and own bill never appear', async () => {
    const buckets = await getAPAging(S.A, AS_AT);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => [b.entityId, b.entityName, b.total]).sort()).toEqual([
      [S.SUPP_A, `Tenant A Supplier ${S.TAG}`, AMOUNTS.apOk],
      [S.SUPP_B, UNKNOWN_SUPPLIER, AMOUNTS.apPoisoned],
    ].sort());
    expect(buckets.reduce((t, b) => t + b.total, 0)).toBe(AP_TOTAL);
    const json = JSON.stringify(buckets);
    expect(json).not.toContain(S.LEAK_SUPPLIER);
    expect(mentionsTenantBAmount(json)).toBe(false);
  });

  it('the AP open-items read keeps the foreign-supplier bill as unknown and carries none of B\'s', async () => {
    const rows = await fetchAPAgingInvoices(S.A, AS_AT, AS_AT);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.entityName).sort()).toEqual([`Tenant A Supplier ${S.TAG}`, UNKNOWN_SUPPLIER].sort());
    expect(rows.map((r) => r.balance).sort((a, b) => a - b)).toEqual([AMOUNTS.apPoisoned, AMOUNTS.apOk]);
    expect(JSON.stringify(rows)).not.toContain(S.LEAK_SUPPLIER);
  });

  it('the AP age-analysis route lists the foreign-supplier bill as unknown, and its summary totals equal its rows', async () => {
    const { status, data } = await callApRoute();
    expect(status).toBe(200);
    expect(data.rows).toHaveLength(2);
    expect(data.rows.map((r) => [r.supplier_name, Number(r.balance_due)]).sort()).toEqual([
      [`Tenant A Supplier ${S.TAG}`, AMOUNTS.apOk],
      [UNKNOWN_SUPPLIER, AMOUNTS.apPoisoned],
    ].sort());
    const rowsTotal = data.rows.reduce((t, r) => t + Number(r.balance_due), 0);
    const summaryTotal = data.summary.reduce((t, b) => t + Number(b.total), 0);
    expect(rowsTotal).toBe(AP_TOTAL);
    expect(summaryTotal).toBe(rowsTotal);
    expect(data.summary.reduce((t, b) => t + b.count, 0)).toBe(data.rows.length);
    const json = JSON.stringify(data);
    expect(json).not.toContain(S.LEAK_SUPPLIER);
    expect(mentionsTenantBAmount(json)).toBe(false);
  });

  // The dashboard tile and the open-items export read the same fetchers; the
  // foreign-party document stays in their totals too, and B never appears.
  it.each([
    ['ar', AR_TOTAL, 'LEAK_CUSTOMER'],
    ['ap', AP_TOTAL, 'LEAK_SUPPLIER'],
  ] as const)('the %s dashboard open book and open-items export agree with the aging total and carry nothing of B\'s', async (side, total, leak) => {
    const book = await getOpenBook(S.A, side, AS_AT);
    expect(book.total).toBe(total);
    const items = await buildOpenItems(S.A, side, AS_AT);
    expect(items.summary.grossTotal).toBe(total);
    expect(items.summary.invoiceCount).toBe(2);
    const json = JSON.stringify([book, items]);
    expect(json).not.toContain(S[leak]);
    expect(mentionsTenantBAmount(json)).toBe(false);
  }, 30000);
});
