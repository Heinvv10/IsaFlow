/**
 * Goods received note suites (docs/design/mcp-goods-received.md): the PO / bill seeds of poMaintHarness / poBillLinkHarness, the
 * rows a test reads back, a call through a real McpRegistry (idempotency and the dry-run key rule), and the cleanup. Tools run as a
 * real MCP call runs them: one app_user transaction with the member's claims and the company GUC. Disposable databases only.
 */
import type { Pool } from 'pg';
import { McpRegistry } from '@/lib/mcp/registry';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';
import { openRequest, type BillFixture } from './budgetBillFixture';
import type { QtyPo } from './poMaintHarness';

export { callTool, glCount, seedQtyPo, dropMaintExtras, type Json, type QtyPo } from './poMaintHarness';

/** create_goods_received arguments: one line per `[po line index, quantity_received, quantity_rejected?]`. */
export function grnArgs(po: QtyPo, lines: Array<[number, number, number?]>, extra: Record<string, unknown> = {}) {
  return {
    po_id: po.po, received_date: '2026-06-20',
    lines: lines.map(([i, received, rejected]) => ({ po_item_id: po.items[i], quantity_received: received, ...(rejected ? { quantity_rejected: rejected } : {}) })),
    ...extra,
  };
}

/** Parses a refusal (a JSON tool error). */
export const refusal = (text: string) => JSON.parse(text) as { refused: boolean; code: string; message: string; lines?: Array<Record<string, unknown>> } & Record<string, unknown>;

export async function poState(pool: Pool, po: QtyPo): Promise<{ status: string; received: number[] }> {
  const head = (await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [po.po])).rows[0] as { status: string };
  const lines = (await pool.query('SELECT id, quantity_received FROM po_items WHERE purchase_order_id = $1', [po.po])).rows as Array<{ id: string; quantity_received: string }>;
  return { status: head.status, received: po.items.map((id) => Number(lines.find((l) => l.id === id)!.quantity_received)) };
}

export async function grnRows(pool: Pool, f: BillFixture) {
  return (await pool.query(
    `SELECT id, grn_number, status, purchase_order_id, external_system, external_ref, cancelled_by, cancel_reason, (cancelled_at IS NOT NULL) AS has_cancelled_at
       FROM goods_received_notes WHERE company_id = $1 ORDER BY grn_number`, [f.co])).rows as Array<Record<string, string | boolean | null>>;
}

export async function grnAudit(pool: Pool, f: BillFixture, grn: string) {
  return (await pool.query(
    `SELECT action, user_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'goods_received_note' AND entity_id = $2 ORDER BY created_at, id`,
    [f.co, grn])).rows as Array<{ action: string; user_id: string; changes: { fields: unknown[]; metadata: Record<string, string> } }>;
}

export async function grnItemCount(pool: Pool, f: BillFixture): Promise<number> {
  return Number((await pool.query(
    'SELECT count(*) AS n FROM grn_items WHERE grn_id IN (SELECT id FROM goods_received_notes WHERE company_id = $1)', [f.co])).rows[0].n);
}

/** Through a real McpRegistry (idempotency keys stored in mcp_tool_calls), as `role` of the fixture's company, committed. */
export async function callRegistry(pool: Pool, f: BillFixture, tool: McpTool, args: Record<string, unknown>, role = 'owner') {
  const registry = new McpRegistry();
  registry.register(tool);
  const user = role === 'manager' ? f.manager : f.owner;
  const ctx = { userId: user, companyId: f.co, scopes: ['write:invoices', 'read:invoices'], tokenJti: 'jti-grn', oauthAppId: null, companyRole: role } as McpToolContext;
  const req = await openRequest(pool, f, user);
  try {
    const out = await req.run(() => registry.call(tool.name, args, ctx));
    await req.commit();
    return { isError: out.isError === true, text: out.content[0]!.text };
  } catch (err) {
    await req.rollback();
    throw err;
  }
}

/** Notes, their documents and upload intents hang off the company: drop them before dropMaintExtras / dropBillFixture. */
export async function dropGrnExtras(pool: Pool, f: BillFixture | undefined): Promise<void> {
  if (!f) return;
  await pool.query(`DELETE FROM procurement_documents WHERE entity_type = 'goods_received'
                     AND entity_id IN (SELECT id FROM goods_received_notes WHERE company_id = $1)`, [f.co]);
  await pool.query('DELETE FROM mcp_upload_intents WHERE company_id = $1', [f.co]);
  const c = await pool.connect();
  try {
    // A bill's own guards (approved bills are frozen) are not what this cleanup is about.
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query('UPDATE supplier_invoices SET grn_id = NULL WHERE company_id = $1', [f.co]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
