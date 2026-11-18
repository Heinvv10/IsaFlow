/**
 * Write side of bulk_create_purchase_orders: purchase orders with the caller's own numbers (a Sage migration keeps
 * PO0000197..PO0000953), posting nothing. The MCP tool parses, ownership-checks and prices every PO first
 * (`mcp/tools/purchaseOrderImportArgs`); this runs inside the tool's savepoint, so any throw discards the whole batch.
 *
 * Lock order, each taken once, before the first write:
 *   1. the company budget lock (block policy only, and only when a PO is imported approved): the PO approval's own
 *      first lock (`purchaseOrderApprove`), so this never waits on it in the other order;
 *   2. the company's purchase_order number counter row FOR UPDATE (bounded 5 s -> ROW_LOCK_TIMEOUT): every PO
 *      writer that mints a number takes it before inserting (`reserveNextDocumentNumber`), so with it held no other
 *      request can insert a PO number in this company until this batch commits; the existence check below cannot race;
 *   3. one advisory lock per external reference, in sorted order (two batches naming the same Sage ids never cross).
 *
 * A PO whose (external_system, external_ref) is already on a PO of this company, in any status, is NOT created again:
 * it comes back already_existed (with payload_differs when its number, date or total differ). Any other PO whose
 * number already exists is refused, and so is the batch: nothing is written. `approved` POs pass the same budget
 * check the Approve action runs (channel mcp, the gate held) before they count as committed; a block refusal throws
 * BudgetExceededError, discarding the batch. Its refused event is not recorded: the PO it would name never existed.
 * After the inserts the counter's next_number is raised to at least (highest imported number + 1) when the numbers
 * are the counter's own form (prefix + digits), so the next PO made in the app does not collide.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { withRowLockBudget, RowLockTimeoutError } from '../core/rowLockBudget';
import { ensureDocumentNumbers } from '../core/companySettingsService';
import { findByExternalRef, lockExternalRef } from '../core/externalRefService';
import { logAuditOrThrow } from '../core/auditTrailService';
import { openBudgetGate } from '../budgets/budgetCheck';
import type { BudgetGate } from '../budgets/budgetCheckTypes';
import { checkPurchaseOrderBudget } from './purchaseOrderBudget';
import type { PoCents } from './purchaseOrderImportAmounts';

export type ImportPoStatus = 'draft' | 'approved' | 'closed' | 'cancelled';

export interface ImportPoLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  netCents: number;
  taxCents: number;
  glAccountId: string | null;
  productId: string | null;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

export interface ImportPo {
  index: number;
  poNumber: string;
  supplierId: string;
  orderDate: string;
  deliveryDate: string | null;
  reference: string | null;
  notes: string | null;
  status: ImportPoStatus;
  ref: { system: string; ref: string; documentNumber: string | null } | null;
  totals: PoCents;
  lines: ImportPoLine[];
}

export interface ImportedPo {
  index: number;
  id: string;
  po_number: string;
  status: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  already_existed: boolean;
  payload_differs?: boolean;
  differences?: { field: string; existing: unknown; requested: unknown }[];
  budget_warnings?: string[];
}

export interface ImportResult {
  purchaseOrders: ImportedPo[];
  /** The purchase_order counter after the batch; raised: this call moved it. */
  counter: { prefix: string; next_number: number; raised: boolean };
}

/** A refusal decided before the first write: nothing was written. */
export class PurchaseOrderImportRefusal extends Error {
  readonly code = 'PURCHASE_ORDER_IMPORT_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'PurchaseOrderImportRefusal';
  }
}

export interface ImportOptions {
  userId: string;
  /** The tool name, for the audit rows. */
  source: string;
  /** May refusals and warnings show budget figures (read:reports). */
  budgetFigures: boolean;
}

const r2 = (c: number) => c / 100;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function lockCounter(companyId: string): Promise<{ prefix: string; next: number }> {
  await ensureDocumentNumbers(companyId);
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT prefix, next_number FROM company_document_numbers
     WHERE company_id = ${companyId}::UUID AND document_type = 'purchase_order'
       FOR UPDATE
  `) as DbRow[], () => new RowLockTimeoutError('The purchase order number counter'));
  return { prefix: String(rows[0]!.prefix), next: Number(rows[0]!.next_number) };
}

/** Existing POs carrying each element's reference (any status: a cancelled Sage PO re-sent is the same PO). */
async function replays(companyId: string, items: readonly ImportPo[]): Promise<Map<number, ImportedPo>> {
  const out = new Map<number, ImportedPo>();
  const withRef = items.filter((p) => p.ref).sort((a, b) => `${a.ref!.system}\u0000${a.ref!.ref}`.localeCompare(`${b.ref!.system}\u0000${b.ref!.ref}`));
  for (const p of withRef) await lockExternalRef(companyId, 'purchase_order', p.ref!.system, p.ref!.ref);
  for (const p of withRef) {
    const found = (await findByExternalRef(companyId, 'purchase_order', p.ref!.system, p.ref!.ref))[0];
    if (!found) continue;
    const differences: { field: string; existing: unknown; requested: unknown }[] = [];
    if (found.number !== p.poNumber) differences.push({ field: 'po_number', existing: found.number, requested: p.poNumber });
    if (found.date !== p.orderDate) differences.push({ field: 'order_date', existing: found.date, requested: p.orderDate });
    if (found.totalAmount !== null && Math.round(found.totalAmount * 100) !== p.totals.total) {
      differences.push({ field: 'total', existing: found.totalAmount, requested: r2(p.totals.total) });
    }
    const stored = (await sql`
      SELECT subtotal, tax_amount, total FROM purchase_orders WHERE id = ${found.id}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    out.set(p.index, {
      index: p.index, id: found.id, po_number: String(found.number), status: String(found.status),
      subtotal: Number(stored[0]?.subtotal ?? 0), tax_amount: Number(stored[0]?.tax_amount ?? 0), total: Number(stored[0]?.total ?? 0),
      already_existed: true, payload_differs: differences.length > 0, ...(differences.length > 0 ? { differences } : {}),
    });
  }
  return out;
}

async function insertPo(companyId: string, p: ImportPo, userId: string): Promise<string> {
  const approved = p.status === 'approved';
  const rows = (await sql`
    INSERT INTO purchase_orders (
      company_id, po_number, supplier_id, order_date, expected_delivery_date, status, subtotal, tax_amount, total,
      notes, reference, created_by, updated_by, approved_by, approved_at,
      external_system, external_ref, external_document_number
    ) VALUES (
      ${companyId}::UUID, ${p.poNumber}, ${p.supplierId}::UUID, ${p.orderDate}::DATE, ${p.deliveryDate}::DATE, ${p.status},
      ${r2(p.totals.subtotal)}, ${r2(p.totals.tax)}, ${r2(p.totals.total)}, ${p.notes}, ${p.reference}, ${userId}, ${userId},
      ${approved ? userId : null}, ${approved ? new Date().toISOString() : null}::TIMESTAMPTZ,
      ${p.ref?.system ?? null}, ${p.ref?.ref ?? null}, ${p.ref?.documentNumber ?? null}
    ) RETURNING id
  `) as DbRow[];
  const id = String(rows[0]!.id);
  const l = p.lines;
  await sql`
    INSERT INTO po_items (purchase_order_id, product_id, description, quantity, unit_price, tax_rate, line_total, tax_amount,
                          gl_account_id, cc1_id, cc2_id, bu_id, sort_order)
    SELECT ${id}::UUID, x.product_id, x.description, x.quantity, x.unit_price, x.tax_rate, x.line_total, x.tax_amount,
           x.gl_account_id, x.cc1_id, x.cc2_id, x.bu_id, x.sort_order
      FROM unnest(${l.map((x) => x.productId)}::UUID[], ${l.map((x) => x.description)}::TEXT[], ${l.map((x) => x.quantity)}::NUMERIC[],
                  ${l.map((x) => x.unitPrice)}::NUMERIC[], ${l.map((x) => x.taxRate)}::NUMERIC[], ${l.map((x) => r2(x.netCents))}::NUMERIC[],
                  ${l.map((x) => r2(x.taxCents))}::NUMERIC[], ${l.map((x) => x.glAccountId)}::UUID[], ${l.map((x) => x.cc1Id)}::UUID[],
                  ${l.map((x) => x.cc2Id)}::UUID[], ${l.map((x) => x.buId)}::UUID[], ${l.map((_, i) => i)}::INT[])
        AS x(product_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, gl_account_id, cc1_id, cc2_id, bu_id, sort_order)
  `;
  return id;
}

/** Raise the counter past the highest imported number of its own form; returns the counter after. */
async function raiseCounter(companyId: string, prefix: string, numbers: readonly string[]): Promise<number> {
  const form = new RegExp(`^${escapeRe(prefix)}(\\d{1,9})$`);
  const max = Math.max(0, ...numbers.map((n) => form.exec(n)?.[1]).filter((d): d is string => !!d).map(Number));
  const rows = (await sql`
    UPDATE company_document_numbers SET next_number = GREATEST(next_number, ${max + 1})
     WHERE company_id = ${companyId}::UUID AND document_type = 'purchase_order'
    RETURNING next_number
  `) as DbRow[];
  return Number(rows[0]!.next_number);
}

export async function importPurchaseOrders(companyId: string, items: readonly ImportPo[], opts: ImportOptions): Promise<ImportResult> {
  const gate: BudgetGate | null = items.some((p) => p.status === 'approved') ? await openBudgetGate(companyId, 'take') : null;
  const counter = await lockCounter(companyId);
  const replayed = await replays(companyId, items);
  const fresh = items.filter((p) => !replayed.has(p.index));

  const taken = (await sql`
    SELECT po_number FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND po_number = ANY(${fresh.map((p) => p.poNumber)}::TEXT[])
  `) as DbRow[];
  if (taken.length > 0) {
    const numbers = new Set(taken.map((r) => String(r.po_number)));
    const first = fresh.find((p) => numbers.has(p.poNumber))!;
    throw new PurchaseOrderImportRefusal(
      `purchase_orders[${first.index}]: po_number ${first.poNumber} already exists in this company`
      + `${numbers.size > 1 ? ` (and ${numbers.size - 1} more of this batch's numbers)` : ''}; nothing was created`,
    );
  }

  const out: ImportedPo[] = [...replayed.values()];
  for (const p of fresh) {
    const id = await insertPo(companyId, p, opts.userId);
    let budgetWarnings: string[] = [];
    if (p.status === 'approved' && gate) {
      const check = await checkPurchaseOrderBudget(
        companyId, { id, poNumber: p.poNumber, status: 'approved', month: p.orderDate.slice(0, 7) }, gate,
        { channel: 'mcp', lock: 'held', gate, figures: opts.budgetFigures }, opts.userId,
      );
      budgetWarnings = check.warnings;
    }
    await logAuditOrThrow({
      companyId, userId: opts.userId, action: 'create', entityType: 'purchase_order', entityId: id, entityRef: p.poNumber.slice(0, 100),
      changes: {
        fields: [{ field: 'status', old: null, new: p.status, label: 'Status' }],
        metadata: {
          source: opts.source, total: r2(p.totals.total).toFixed(2),
          ...(p.ref ? { externalSystem: p.ref.system, externalRef: p.ref.ref } : {}),
        },
      },
    });
    out.push({
      index: p.index, id, po_number: p.poNumber, status: p.status, subtotal: r2(p.totals.subtotal), tax_amount: r2(p.totals.tax),
      total: r2(p.totals.total), already_existed: false, ...(budgetWarnings.length > 0 ? { budget_warnings: budgetWarnings } : {}),
    });
  }

  const next = await raiseCounter(companyId, counter.prefix, items.map((p) => p.poNumber));
  return {
    purchaseOrders: out.sort((a, b) => a.index - b.index),
    counter: { prefix: counter.prefix, next_number: next, raised: next > counter.next },
  };
}
