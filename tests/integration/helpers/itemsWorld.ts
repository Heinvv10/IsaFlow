/**
 * The item-master integration suites' world: two unrelated companies (A, B), each with an owner, an expense account, a
 * revenue account and an inactive expense account, a supplier and a customer. Synthetic values only; nothing here names
 * a live company. Calls go through the REAL registry as app_user (helpers/mcpBudgetFixture).
 */
import type { Pool } from 'pg';
import { newSetupUser, type SetupUser } from './onboardingSetupFixture';
import { body, mcp, mcpBatch, type BatchStep } from './mcpBudgetFixture';
import type { McpToolResult } from '@/lib/mcp/types';

export const ITEM_SCOPES = ['read:items', 'write:items', 'read:invoices', 'write:invoices', 'read:contacts'];

export interface Side {
  u: SetupUser;
  expense: string;
  revenue: string;
  inactive: string;
  supplier: string;
  customer: string;
}
export interface ItemsWorld { a: Side; b: Side }

async function side(pool: Pool, tag: string): Promise<Side> {
  const u = await newSetupUser(pool);
  const account = async (code: string, type: string, subtype: string, active: boolean) => String((await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [u.homeCompanyId, `${tag}-${code}`, `${tag} ${code}`, type, subtype, type === 'revenue' ? 'credit' : 'debit', active])).rows[0].id);
  const expense = await account('5000', 'expense', 'operating_expense', true);
  const revenue = await account('4000', 'revenue', 'revenue', true);
  const inactive = await account('5900', 'expense', 'operating_expense', false);
  const supplier = String((await pool.query('INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING id', [u.homeCompanyId, `${tag} supplier`])).rows[0].id);
  const customer = String((await pool.query('INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id', [u.homeCompanyId, `${tag} customer`])).rows[0].id);
  return { u, expense, revenue, inactive, supplier, customer };
}

export async function itemsWorld(pool: Pool): Promise<ItemsWorld> {
  return { a: await side(pool, 'IA'), b: await side(pool, 'IB') };
}

let seq = 0;
export const key = (): string => `k-${++seq}-${crypto.randomUUID().slice(0, 8)}`;

/** One call as `s`'s owner with the item scopes; a write gets a fresh idempotency key unless it names one. */
export function as(pool: Pool, s: Side) {
  const run = (name: string, args: Record<string, unknown> = {}, scopes = ITEM_SCOPES): Promise<McpToolResult> =>
    mcp(pool, s.u, name, WRITE_TOOLS.has(name) && !args.idempotency_key ? { ...args, idempotency_key: key() } : args, { scopes });
  const ok = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => body(await run(name, args));
  const batch = (steps: BatchStep[]): Promise<McpToolResult[]> => mcpBatch(pool, s.u, steps, { scopes: ITEM_SCOPES });
  return { run, ok, batch };
}

const WRITE_TOOLS = new Set([
  'bulk_upsert_items', 'update_item', 'deactivate_item', 'upsert_item_category', 'create_supplier_invoice', 'create_draft_invoice',
  'create_draft_quote', 'bulk_create_supplier_invoices', 'bulk_create_customer_invoices',
]);

export const CATEGORIES = ['optics', 'stringing', 'backhaul', 'activations', 'poles', 'tools'] as const;

/** 383 Sage-shaped items: codes, external references, 271 physical and 112 service, six categories. */
export function sageItems(side: Pick<Side, 'expense' | 'revenue'>): Array<Record<string, unknown>> {
  return Array.from({ length: 383 }, (_, n) => {
    const i = n + 1;
    const service = (i * 7) % 383 < 112; // a permutation of 0..382: exactly 112 services
    return {
      code: `SGE-${String(i).padStart(4, '0')}`,
      description: `${service ? 'Service' : 'Stock'} item ${i}`,
      item_type: service ? 'service' : 'physical',
      unit: service ? 'hour' : 'each',
      category_code: CATEGORIES[i % CATEGORIES.length],
      purchase_price: service ? 0 : (i % 50) + 0.5,
      sales_price: (i % 90) + 10.25,
      vat_on_sales: i % 11 === 0 ? 'zero' : 'standard',
      sales_account_id: side.revenue,
      ...(service ? {} : { purchases_account_id: side.expense }),
      inventory_tracked: false,
      external_system: 'sage',
      external_ref: String(50000 + i),
      external_document_number: `ITM${String(i).padStart(5, '0')}`,
    };
  });
}

export async function cleanupWorld(pool: Pool, w: ItemsWorld): Promise<void> {
  for (const s of [w.a, w.b]) {
    const c = s.u.homeCompanyId;
    await pool.query('DELETE FROM mcp_tool_calls WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [c]);
    await pool.query('DELETE FROM purchase_orders WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1)', [c]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1)', [c]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM customer_quote_lines WHERE quote_id IN (SELECT id FROM customer_quotes WHERE company_id = $1)', [c]);
    await pool.query('DELETE FROM customer_quotes WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM stock_movements WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM warehouses WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM products WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM items WHERE company_id = $1', [c]);
    await pool.query('DELETE FROM item_categories WHERE company_id = $1', [c]);
  }
}
