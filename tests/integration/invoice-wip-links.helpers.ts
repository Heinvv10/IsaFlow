/**
 * Shared by the draft-edit WIP-link suites (PR S): a company with an owner, a WIP draft whose two lines bill one time
 * entry each (as practiceWipService writes them), and readers for its lines and entries. `ctx` is filled in beforeAll.
 */
import type { Pool } from 'pg';
import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { callRoute } from './r035-approval.helpers';
import { plantInvoice } from './r035-pr4.helpers';

export interface WipCtx { pool: Pool; tokens: Record<string, string>; owner: string; company: string; otherCompany: string }

export const wipPut = (ctx: WipCtx, body: unknown) =>
  callRoute(customerInvoicesDetail, ctx.tokens[ctx.owner]!, ctx.company, 'PUT', body, '/api/accounting/customer-invoices-detail');

/** A time entry of `companyId`: billed to `invoiceId` by the WIP path, or approved and unbilled. */
export async function timeEntry(ctx: WipCtx, companyId: string, invoiceId: string | null): Promise<string> {
  const { rows } = await ctx.pool.query(
    `INSERT INTO time_entries (company_id, user_id, task_description, hours, rate, status, invoice_id, billed_at)
     VALUES ($1, $2, 'WIP work', 2, 300, $3, $4, CASE WHEN $4::UUID IS NULL THEN NULL ELSE NOW() END) RETURNING id`,
    [companyId, ctx.owner, invoiceId ? 'billed' : 'approved', invoiceId]);
  return rows[0].id as string;
}

/** A WIP draft: 'Time A' (2 × 300) and 'Time B' (1 × 400), each billing one time entry. */
export async function wipDraft(ctx: WipCtx): Promise<{ id: string; entries: string[] }> {
  const inv = await plantInvoice(ctx.pool, ctx.company, ctx.owner);
  await ctx.pool.query('DELETE FROM customer_invoice_items WHERE invoice_id = $1', [inv.id]);
  const entries = [await timeEntry(ctx, ctx.company, inv.id), await timeEntry(ctx, ctx.company, inv.id)];
  await ctx.pool.query(
    `INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount, tax_rate, currency_code, time_entry_id)
     VALUES ($1, 'Time A', 2, 300, 600, 15, 'ZAR', $2), ($1, 'Time B', 1, 400, 400, 15, 'ZAR', $3)`, [inv.id, entries[0], entries[1]]);
  return { id: inv.id, entries };
}

export const links = async (ctx: WipCtx, id: string) => (await ctx.pool.query(
  'SELECT description, quantity::TEXT AS quantity, time_entry_id FROM customer_invoice_items WHERE invoice_id = $1 ORDER BY description', [id])).rows;

export const entry = async (ctx: WipCtx, id: string) => (await ctx.pool.query(
  'SELECT status, invoice_id, billed_at IS NOT NULL AS billed FROM time_entries WHERE id = $1', [id])).rows[0] as
  { status: string; invoice_id: string | null; billed: boolean };

export const putBody = (id: string, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  id, invoiceDate: '2026-09-01', taxRate: 15, currencyCode: 'ZAR', exchangeRate: 1, items, ...extra,
});
