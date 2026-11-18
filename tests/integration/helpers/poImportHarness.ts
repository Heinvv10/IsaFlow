/**
 * bulk_create_purchase_orders suites: the MCP tools run as a real MCP call runs them, one app_user transaction with the
 * member's claims and the company GUC (budgetBillFixture.openRequest), committed after the handler returns, so grants,
 * RLS, triggers and the 1001 CHECKs all apply. POs are built Sage-shaped (PO0000197 ...).
 */
import type { Pool } from 'pg';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';
import { openRequest, type BillFixture } from './budgetBillFixture';

export type Json = Record<string, unknown>;

let key = 0;

/** Runs `tool` as `user` of `f` (default the owner) in its own committed app_user transaction. */
export async function callTool(
  pool: Pool, f: BillFixture, tool: McpTool, args: Json, over: Partial<McpToolContext> & { user?: string } = {},
): Promise<{ isError: boolean; body: Json; text: string; wroteNothing: boolean }> {
  const user = over.user ?? f.owner;
  const ctx = {
    userId: user, companyId: f.co, scopes: ['write:invoices', 'read:invoices', 'read:reports', 'write:bank-tx'],
    tokenJti: 'jti-po', oauthAppId: null, ...over,
  } as McpToolContext;
  const req = await openRequest(pool, f, user);
  try {
    const out = await req.run(() => tool.handler({ idempotency_key: `po-${key++}`, ...args }, ctx));
    await req.commit();
    const text = out.content[0]!.text;
    let body: Json = {};
    try { body = JSON.parse(text) as Json; } catch { body = {}; }
    return { isError: out.isError === true, body, text, wroteNothing: out.wroteNothing === true };
  } catch (err) {
    await req.rollback();
    throw err;
  }
}

/** Runs `fn` as the owner inside an app_user transaction that is rolled back. */
export async function asOwner<T>(pool: Pool, f: BillFixture, fn: () => Promise<T>): Promise<T> {
  const req = await openRequest(pool, f, f.owner);
  try { return await req.run(fn); } finally { await req.rollback(); }
}

export const poNumber = (n: number) => `PO${String(n).padStart(7, '0')}`;

/** A Sage-shaped PO: one line on `acct`, qty 2 at `price`, 15% VAT, the source's own totals sent. */
export function sagePo(n: number, f: BillFixture, opts: {
  status?: string; acct?: string | null; price?: number; date?: string; cc1?: string; ref?: string | number; inclusive?: boolean;
} = {}): Json {
  const price = opts.price ?? 100 + n;
  const net = Math.round(2 * price * 100) / 100;
  const tax = Math.round(net * 15) / 100;
  return {
    po_number: poNumber(n), supplier_id: f.supplier, order_date: opts.date ?? '2026-06-10', status: opts.status ?? 'open',
    external_system: 'sage', external_ref: opts.ref ?? String(900000 + n), external_document_number: poNumber(n),
    reference: `Sage ${n}`,
    expected_totals: { subtotal: net, tax_amount: tax, total: Math.round((net + tax) * 100) / 100 },
    lines: [{
      description: `Line of ${poNumber(n)}`, quantity: 2, unit_price: price, tax_rate: 15,
      ...(opts.acct === undefined ? { gl_account_id: f.acc.nob } : opts.acct ? { gl_account_id: opts.acct } : {}),
      ...(opts.cc1 ? { cc1: opts.cc1 } : {}),
    }],
  };
}

export async function poCount(pool: Pool, f: BillFixture): Promise<number> {
  return Number((await pool.query('SELECT count(*) AS n FROM purchase_orders WHERE company_id = $1', [f.co])).rows[0].n);
}

export async function counterNext(pool: Pool, f: BillFixture): Promise<number | null> {
  const r = await pool.query(
    "SELECT next_number FROM company_document_numbers WHERE company_id = $1 AND document_type = 'purchase_order'", [f.co]);
  return r.rows[0] ? Number(r.rows[0].next_number) : null;
}

/** procurement_documents has no company_id: drop this company's PO documents before the fixture drops the POs. */
export async function dropPoDocuments(pool: Pool, f: BillFixture | undefined): Promise<void> {
  if (!f) return;
  await pool.query(`DELETE FROM procurement_documents WHERE entity_type = 'purchase_order'
                     AND entity_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)`, [f.co]);
}
