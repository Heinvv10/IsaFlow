/**
 * K-058 — RED. Three debtors-dashboard queries key on `ci.client_id` alone
 * where the rest of AR uses `COALESCE(ci.client_id, ci.customer_id)`:
 *
 *   getDebtorsSummary   INNER JOIN customers ON c.id = ci.client_id  (line 115)
 *   getDebtorDetail     WHERE ci.client_id = $2                      (line 163)
 *   getOverdueInvoices  INNER JOIN customers ON c.id = ci.client_id  (line 214)
 *
 * `customer_invoices.client_id` is NULLABLE; `customer_id` is NOT NULL (fixture
 * schema, information_schema). An invoice with a NULL client_id therefore
 * matches nothing in the inner join and is dropped silently — it is not shown,
 * not totalled, and not reported as excluded.
 *
 * `getARAging` (arAgingService.ts:41,44) reads the same invoices through
 * COALESCE and DOES include it, so the debtors dashboard and the AR aging
 * report disagree about the same book. This test asserts both surfaces see the
 * same money, which is the property that actually matters.
 *
 * Expected on a fixed build: R1,750 on both. On origin/master the dashboard
 * reports R1,000 and aging reports R1,750.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import {
  getDebtorsSummary,
  getOverdueInvoices,
  getDebtorDetail,
  getCollectionStats,
} from '@/modules/accounting/services/ar/debtorsManagerService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
// A third book, used only by the un-nameable-debtor cases. They stay out of
// COMPANY so the debtors-vs-aging total agreement above is asserted on a book
// that has no orphan id — see the ORPHAN test for why that distinction matters.
const NAMELESS_COMPANY = randomUUID();
const ORPHAN_ID = randomUUID();
const USER = randomUUID();
const TAG = `K058-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const LINKED = 1000;
const LEGACY = 750;
const SPLIT = 400;
const LEGACY_ONLY = 250;
const OTHER = 9999;
const FOREIGN = 600;
const ORPHAN = 400;
const FOREIGN_C = 800;

let customer: string;
let otherCustomer: string;
let billTo: string;
let legacyOnly: string;

describeIfDb('K-058 debtors dashboard drops invoices with a NULL client_id', () => {
  beforeAll(async () => {
    await sql`INSERT INTO companies (id, name, registration_number, created_at)
              VALUES (${COMPANY}::UUID, ${'K058 ' + TAG}, ${TAG}, NOW()),
                     (${OTHER_COMPANY}::UUID, ${'K058 other ' + TAG}, ${TAG + '-O'}, NOW()),
                     (${NAMELESS_COMPANY}::UUID, ${'K058 nameless ' + TAG}, ${TAG + '-N'}, NOW())`;
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'K058 ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    billTo = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'K058 billto ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    legacyOnly = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'K058 legacyonly ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    otherCustomer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${OTHER_COMPANY}::UUID, ${'K058 other ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      INSERT INTO customer_invoices
        (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by)
      VALUES
        (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + '-LINKED'}, '2026-01-15', '2026-02-15', 'approved', ${LINKED}, 0, ${USER}::UUID),
        (${COMPANY}::UUID, NULL,              ${customer}::UUID, ${TAG + '-LEGACY'}, '2026-01-15', '2026-02-15', 'approved', ${LEGACY}, 0, ${USER}::UUID),
        (${COMPANY}::UUID, ${billTo}::UUID,    ${customer}::UUID, ${TAG + '-SPLIT'},  '2026-01-15', '2026-02-15', 'approved', ${SPLIT},  0, ${USER}::UUID),
        (${COMPANY}::UUID, NULL,              ${legacyOnly}::UUID, ${TAG + '-LEGACYONLY'}, '2026-01-15', '2026-02-15', 'approved', ${LEGACY_ONLY}, 0, ${USER}::UUID)`;
    await sql`
      INSERT INTO customer_invoices
        (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by)
      VALUES
        (${OTHER_COMPANY}::UUID, NULL, ${otherCustomer}::UUID, ${TAG + '-OTHER'}, '2026-01-15', '2026-02-15', 'approved', ${OTHER}, 0, ${USER}::UUID)`;
    // Company A's own invoice, but pointing at company B's customer. client_id has
    // no FK and customer_id's FK is not tenant-scoped, so this row is storable.
    await sql`
      INSERT INTO customer_invoices
        (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by)
      VALUES
        (${COMPANY}::UUID, NULL, ${otherCustomer}::UUID, ${TAG + '-FOREIGN'}, '2026-01-15', '2026-02-15', 'approved', ${FOREIGN}, 0, ${USER}::UUID)`;
    // Two debtors of the third company that cannot be named, for different
    // reasons: ORPHAN's client_id matches no customers row anywhere (client_id
    // carries no FK), FOREIGNC's customer_id names company B's customer.
    await sql`
      INSERT INTO customer_invoices
        (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
         status, total_amount, amount_paid, created_by)
      VALUES
        (${NAMELESS_COMPANY}::UUID, ${ORPHAN_ID}::UUID, ${otherCustomer}::UUID, ${TAG + '-ORPHAN'}, '2026-01-15', '2026-02-15', 'approved', ${ORPHAN}, 0, ${USER}::UUID),
        (${NAMELESS_COMPANY}::UUID, NULL, ${otherCustomer}::UUID, ${TAG + '-FOREIGNC'}, '2026-01-15', '2026-02-15', 'approved', ${FOREIGN_C}, 0, ${USER}::UUID)`;
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID, ${NAMELESS_COMPANY}::UUID)`;
    await sql`DELETE FROM customers WHERE company_id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID, ${NAMELESS_COMPANY}::UUID)`;
    await sql`DELETE FROM companies WHERE id IN (${COMPANY}::UUID, ${OTHER_COMPANY}::UUID, ${NAMELESS_COMPANY}::UUID)`;
  }, 60000);

  it('AR aging already counts the NULL client_id invoice', async () => {
    const buckets = await getARAging(COMPANY);
    const row = buckets.find((b) => b.entityId === customer);
    expect(row).toBeDefined();
    expect(row!.total).toBeCloseTo(LINKED + LEGACY, 2);
  });

  it('the debtors summary agrees with AR aging', async () => {
    const summary = await getDebtorsSummary(COMPANY);
    const total = summary.reduce((s, d) => s + d.totalOutstanding, 0);
    // Compare against what the aging report actually returns, not against a
    // constant: the property fix.md leads with is that the two SURFACES agree,
    // and only a call to getARAging can fail when one of them drifts.
    const aging = await getARAging(COMPANY);
    const agingTotal = aging.reduce((s, b) => s + b.total, 0);
    expect(total).toBeCloseTo(agingTotal, 2);
    expect(total).toBeCloseTo(LINKED + LEGACY + SPLIT + LEGACY_ONLY + FOREIGN, 2);
  });

  it('the overdue list shows the NULL client_id invoice', async () => {
    const overdue = await getOverdueInvoices(COMPANY);
    expect(overdue.map((i) => i.invoiceNumber).sort()).toEqual(
      [TAG + '-FOREIGN', TAG + '-LEGACY', TAG + '-LEGACYONLY', TAG + '-LINKED', TAG + '-SPLIT'],
    );
  });

  // ── Adjacent cases ─────────────────────────────────────────────────────────

  it('groups the legacy invoice under customer_id and leaves an explicit client_id alone', async () => {
    const summary = await getDebtorsSummary(COMPANY);
    const byCustomer = summary.find((d) => d.clientId === customer);
    const byBillTo = summary.find((d) => d.clientId === billTo);
    expect(byCustomer).toBeDefined();
    expect(byBillTo).toBeDefined();
    // COALESCE takes client_id first, so the SPLIT invoice stays with billTo and
    // does NOT collapse into the customer_id group.
    expect(byCustomer!.totalOutstanding).toBeCloseTo(LINKED + LEGACY, 2);
    expect(byCustomer!.invoiceCount).toBe(2);
    expect(byBillTo!.totalOutstanding).toBeCloseTo(SPLIT, 2);
    expect(byBillTo!.invoiceCount).toBe(1);
  });

  it('the drill-down from the summary row returns the legacy invoice', async () => {
    const detail = await getDebtorDetail(COMPANY, customer);
    expect(detail.map((i) => i.invoiceNumber).sort()).toEqual(
      [TAG + '-LEGACY', TAG + '-LINKED'],
    );
    const sum = detail.reduce((s, i) => s + i.outstanding, 0);
    expect(sum).toBeCloseTo(LINKED + LEGACY, 2);
  });

  it('collection stats count the legacy invoice customer exactly once', async () => {
    const stats = await getCollectionStats(COMPANY);
    expect(stats.totalOutstanding).toBeCloseTo(LINKED + LEGACY + SPLIT + LEGACY_ONLY + FOREIGN, 2);
    // customer, billTo, legacyOnly and the un-nameable foreign id. Before the fix
    // the NULL client_id rows were invisible to COUNT DISTINCT and legacyOnly went
    // missing entirely.
    expect(stats.clientCount).toBe(4);
  });

  it('withholds a foreign customer name but keeps the row and its money', async () => {
    const summary = await getDebtorsSummary(COMPANY);
    const overdue = await getOverdueInvoices(COMPANY);
    // The FOREIGN invoice belongs to company A but names company B's customer.
    // The join is tenant-scoped AND outer: the name is withheld, the debt is not.
    const foreignRow = summary.find((d) => d.clientId === otherCustomer);
    expect(foreignRow).toBeDefined();
    expect(foreignRow!.clientName).toBe('Unknown customer ' + otherCustomer.slice(0, 8));
    expect(foreignRow!.totalOutstanding).toBeCloseTo(FOREIGN, 2);
    expect(summary.map((d) => d.clientName)).not.toContain('K058 other ' + TAG);

    const foreignInvoice = overdue.find((i) => i.invoiceNumber === TAG + '-FOREIGN');
    expect(foreignInvoice).toBeDefined();
    expect(foreignInvoice!.clientName).toBe('Unknown customer ' + otherCustomer.slice(0, 8));
    expect(foreignInvoice!.outstanding).toBeCloseTo(FOREIGN, 2);
    expect(overdue.map((i) => i.clientName)).not.toContain('K058 other ' + TAG);
  });

  it('the stat tile accounts for exactly the debtors the table lists', async () => {
    const summary = await getDebtorsSummary(COMPANY);
    const stats = await getCollectionStats(COMPANY);
    expect(stats.clientCount).toBe(summary.length);
    expect(summary.reduce((s, d) => s + d.totalOutstanding, 0)).toBeCloseTo(
      stats.totalOutstanding,
      2,
    );
  });

  it('does not leak the other company\'s NULL client_id invoice', async () => {
    const summary = await getDebtorsSummary(COMPANY);
    // Company B's OWN invoice is out on ci.company_id. (The foreign id itself can
    // legitimately appear here, nameless, when company A's invoice points at it —
    // that case is covered by the "withholds a foreign customer name" test.)
    expect(summary.reduce((s, d) => s + d.totalOutstanding, 0)).toBeCloseTo(
      LINKED + LEGACY + SPLIT + LEGACY_ONLY + FOREIGN,
      2,
    );
    const overdue = await getOverdueInvoices(COMPANY);
    expect(overdue.some((i) => i.invoiceNumber === TAG + '-OTHER')).toBe(false);
    const other = await getDebtorsSummary(OTHER_COMPANY);
    expect(other.reduce((s, d) => s + d.totalOutstanding, 0)).toBeCloseTo(OTHER, 2);
  });

  it('tells two un-nameable debtors apart', async () => {
    const summary = await getDebtorsSummary(NAMELESS_COMPANY);
    const orphanRow = summary.find((d) => d.clientId === ORPHAN_ID);
    const foreignRow = summary.find((d) => d.clientId === otherCustomer);
    expect(orphanRow).toBeDefined();
    expect(foreignRow).toBeDefined();
    // Neither can be named, but a constant placeholder would render them as the
    // same debtor in the table and make them inseparable in the name search.
    expect(orphanRow!.clientName).toBe('Unknown customer ' + ORPHAN_ID.slice(0, 8));
    expect(foreignRow!.clientName).toBe('Unknown customer ' + otherCustomer.slice(0, 8));
    expect(orphanRow!.clientName).not.toBe(foreignRow!.clientName);
    expect(orphanRow!.totalOutstanding).toBeCloseTo(ORPHAN, 2);
    expect(foreignRow!.totalOutstanding).toBeCloseTo(FOREIGN_C, 2);
    // Still no company B name on company C's dashboard.
    expect(summary.map((d) => d.clientName)).not.toContain('K058 other ' + TAG);
    const overdue = await getOverdueInvoices(NAMELESS_COMPANY);
    expect(new Set(overdue.map((i) => i.clientName)).size).toBe(2);
    expect(overdue.map((i) => i.clientName)).not.toContain('K058 other ' + TAG);
  });

  it('records the one case where debtors and AR aging still disagree', async () => {
    // KNOWN LIMIT, asserted rather than only written down (fix.md Limits).
    // getARAging joins customers with an UNSCOPED INNER JOIN, so an id matching
    // no customers row at all is dropped there while the outer join here keeps
    // it. The foreign id is not affected: aging's unscoped join finds company
    // B's customer and keeps that money (and renders that name, which is the
    // other half of the same limit). Scoping arAgingService belongs to K-053,
    // which owns that file.
    const summary = await getDebtorsSummary(NAMELESS_COMPANY);
    const aging = await getARAging(NAMELESS_COMPANY);
    const summaryTotal = summary.reduce((s, d) => s + d.totalOutstanding, 0);
    const agingTotal = aging.reduce((s, b) => s + b.total, 0);
    expect(summaryTotal).toBeCloseTo(ORPHAN + FOREIGN_C, 2);
    expect(agingTotal).toBeCloseTo(FOREIGN_C, 2);
    // The gap is exactly the orphan row, and nothing else.
    expect(summaryTotal - agingTotal).toBeCloseTo(ORPHAN, 2);
    expect(aging.some((b) => b.entityId === ORPHAN_ID)).toBe(false);
  });
});
