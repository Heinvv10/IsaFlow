/**
 * Migration 873, the invoice writers that do NOT carry line coding today: a
 * sales-order conversion (customer_sales_order_items.gl_account_id exists but
 * nothing writes it, and the conversion does not copy it) and a recurring
 * invoice run (its template lines' glAccountId is dropped by parseLineItems).
 * Seeded WITH a coded source line, each still produces an uncoded invoice and
 * posts the single default_revenue leg — and the recurring template's header
 * project tags nothing (D1: only line dimensions post).
 *
 * Disposable databases only (869 and 873 are not on isaflow_dev).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { convertSalesOrderToInvoice } from '@/modules/accounting/services/ar/salesOrderWorkflowService';
import { runRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceRun';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

const revenueOf = async (invoiceId: string) => (await sql`
  SELECT a.account_code AS code, jl.credit::float AS credit, jl.project_id AS project
  FROM customer_invoices ci
  JOIN gl_journal_lines jl ON jl.journal_entry_id = ci.gl_journal_entry_id AND jl.company_id = ci.company_id
  JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
  WHERE ci.id = ${invoiceId}::UUID AND a.account_type = 'revenue' ORDER BY a.account_code`) as
  { code: string; credit: number; project: string | null }[];
const codingOf = async (invoiceId: string) => (await sql`
  SELECT gl_account_id, project_id FROM customer_invoice_items WHERE invoice_id = ${invoiceId}::UUID`) as
  Record<string, string | null>[];

describeIfDisposable('invoice writers without line coding (migration 873)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => {
    if (!f) return;
    await sql`DELETE FROM customer_sales_order_items WHERE sales_order_id IN (
      SELECT id FROM customer_sales_orders WHERE company_id = ${f.fx.companyId}::UUID)`;
    await sql`UPDATE customer_sales_orders SET invoice_id = NULL WHERE company_id = ${f.fx.companyId}::UUID`;
    await sql`DELETE FROM customer_sales_orders WHERE company_id = ${f.fx.companyId}::UUID`;
    await sql`DELETE FROM recurring_invoices WHERE company_id = ${f.fx.companyId}::UUID`;
    await dropLineRevenue(f);
  });

  it('a sales order whose item names a revenue account converts to an uncoded invoice that posts as before', async () => {
    const so = ((await sql`
      INSERT INTO customer_sales_orders (company_id, order_number, customer_id, order_date, subtotal, tax_rate, tax_amount,
                                         total_amount, status, project_id)
      VALUES (${f.fx.companyId}::UUID, 'SO-1', ${f.fx.customerId}::UUID, '2026-07-15', 500, 0, 0, 500, 'confirmed', ${f.project.p1}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO customer_sales_order_items (sales_order_id, line_number, description, quantity, unit_price, tax_rate,
                                                      line_total, gl_account_id)
              VALUES (${so}::UUID, 1, 'Shoot day', 1, 500, 0, 500, ${f.acct.commercials}::UUID)`;
    const { invoiceId } = await inTx(f.fx, () => convertSalesOrderToInvoice(f.fx.companyId, so, f.fx.userId));
    expect(await codingOf(invoiceId)).toEqual([{ gl_account_id: null, project_id: null }]);
    await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, invoiceId, f.fx.userId));
    expect(await revenueOf(invoiceId)).toEqual([{ code: '4000', credit: 500, project: null }]);
  });

  it('a recurring run whose template line names an account, and whose header names a project, posts untagged', async () => {
    const ri = ((await sql`
      INSERT INTO recurring_invoices (company_id, template_name, client_id, project_id, frequency, next_run_date,
                                      line_items, subtotal, tax_rate, tax_amount, total_amount, created_by)
      VALUES (${f.fx.companyId}::UUID, 'Retainer', ${f.fx.customerId}::UUID, ${f.project.p2}::UUID, 'monthly', '2026-07-01',
              ${JSON.stringify([{ description: 'Retainer', quantity: 1, unitPrice: 800, glAccountId: f.acct.commercials }])}::JSONB,
              800, 0, 0, 800, ${f.fx.userId})
      RETURNING id`) as { id: string }[])[0]!.id;
    const run = await inTx(f.fx, () => runRecurringInvoice(f.fx.companyId, ri, f.fx.userId));
    expect(await codingOf(run.invoiceId)).toEqual([{ gl_account_id: null, project_id: null }]);
    expect(await revenueOf(run.invoiceId)).toEqual([{ code: '4000', credit: 800, project: null }]);
  });
});
