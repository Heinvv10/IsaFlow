/**
 * Shared by create_goods_received and cancel_goods_received: argument parsing, the dry-run / live runner, and the typed refusal
 * answered as a JSON tool error (`{ refused, code, message, written: false, ... }`, every refused line listed). Posts nothing.
 */
import { als } from '@/lib/als';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { GoodsReceivedError } from '@/modules/accounting/services/ap/goodsReceivedValidation';
import type { McpToolResult } from '../types';
import { ok, toolError } from './toolHelpers';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';

export const MAX_GRN_LINES = 200;
export const GRN_TEXT_MAX = 500;

export interface CreateGrnArgs {
  input: { purchaseOrderId: string; receivedDate: string; receivedBy?: string; notes?: string; items: Array<Record<string, unknown>> };
  external: { system: string; ref: string } | null;
  dryRun: boolean;
}

const CREATE_KEYS = new Set(['po_id', 'received_date', 'received_by', 'notes', 'lines', 'external_system', 'external_ref', 'dry_run', 'idempotency_key']);
const LINE_KEYS = new Set(['po_item_id', 'quantity_received', 'quantity_rejected', 'notes']);

function optionalText(v: unknown, name: string, max: number): string | undefined | { error: string } {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return { error: `${name} must be a string` };
  if (v.trim().length > max) return { error: `${name} is longer than ${max} characters` };
  return v.trim() || undefined;
}
const isErr = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;
const qty = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/** The create's arguments, or the refusal text. Quantities and the date are checked again by the service (one rule set). */
export function parseCreateGrnArgs(args: Record<string, unknown>): CreateGrnArgs | string {
  const stray = Object.keys(args).find((k) => !CREATE_KEYS.has(k));
  if (stray !== undefined) return `arguments.${stray} is not a field of this tool (allowed: ${[...CREATE_KEYS].join(', ')})`;
  if (typeof args.po_id !== 'string' || !UUID_RE.test(args.po_id)) return 'po_id is required: the purchase order UUID (list_purchase_orders)';
  if (typeof args.received_date !== 'string' || !isRealCalendarDate(args.received_date)) return 'received_date is required: YYYY-MM-DD';
  const receivedBy = optionalText(args.received_by, 'received_by', 200);
  if (isErr(receivedBy)) return receivedBy.error;
  const notes = optionalText(args.notes, 'notes', GRN_TEXT_MAX);
  if (isErr(notes)) return notes.error;
  if (!Array.isArray(args.lines) || args.lines.length === 0) return 'lines is required: at least one {po_item_id, quantity_received}';
  if (args.lines.length > MAX_GRN_LINES) return `too many lines (${args.lines.length}); the maximum is ${MAX_GRN_LINES}`;
  const items: Array<Record<string, unknown>> = [];
  for (const [i, raw] of args.lines.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `lines[${i}] must be an object`;
    const line = raw as Record<string, unknown>;
    const strayKey = Object.keys(line).find((k) => !LINE_KEYS.has(k));
    if (strayKey !== undefined) return `lines[${i}].${strayKey} is not a field of a line (allowed: ${[...LINE_KEYS].join(', ')})`;
    if (typeof line.po_item_id !== 'string' || !UUID_RE.test(line.po_item_id)) return `lines[${i}].po_item_id must be a PO line UUID (get_purchase_order lines[].id)`;
    if (!qty(line.quantity_received)) return `lines[${i}].quantity_received must be a number of at least 0`;
    if (!qty(line.quantity_rejected)) return `lines[${i}].quantity_rejected must be a number of at least 0`;
    const lineNotes = optionalText(line.notes, `lines[${i}].notes`, GRN_TEXT_MAX);
    if (isErr(lineNotes)) return lineNotes.error;
    items.push({ poItemId: line.po_item_id, quantityReceived: line.quantity_received ?? 0, quantityRejected: line.quantity_rejected ?? 0, notes: lineNotes });
  }
  // Lower case BEFORE the length check: that is what is stored, and lowercasing can lengthen a string ('İ' is two units lower case).
  const system = optionalText(typeof args.external_system === 'string' ? args.external_system.toLowerCase() : args.external_system, 'external_system', 32);
  if (isErr(system)) return system.error;
  const rawRef = args.external_ref;
  const ref = typeof rawRef === 'number' && Number.isSafeInteger(rawRef) ? String(rawRef) : optionalText(rawRef, 'external_ref', 128);
  if (isErr(ref)) return ref.error;
  if ((system === undefined) !== (ref === undefined)) return 'external_system and external_ref go together: give both (e.g. "fibreflow" and its delivery id) or neither';
  if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return 'dry_run must be true or false';
  return {
    input: { purchaseOrderId: args.po_id, receivedDate: args.received_date, receivedBy: receivedBy, notes, items },
    external: system && ref ? { system, ref } : null,
    dryRun: args.dry_run === true,
  };
}

/** A dry run needs the request transaction its rollback undoes; outside it the savepoint is a plain call. */
export const grnDryRunNeedsTx = (dryRun: boolean): string | null => (dryRun && !als.getStore()?.client ? 'dry_run needs a request transaction' : null);

/** The refusal as the tool's answer: JSON, so an agent reads the code and every refused line. */
export function grnRefusal(err: GoodsReceivedError, dryRun: boolean): McpToolResult {
  const d = err.details;
  return toolError(JSON.stringify({
    refused: true, code: err.refusal, message: err.refusal === 'not_found' ? 'Not found' : err.message, written: false, dry_run: dryRun,
    ...(d.lines ? {
      lines: d.lines.map((l) => ({
        index: l.index, po_item_id: l.poItemId, code: l.code,
        ...(l.code === 'over_receipt' ? { outstanding: l.outstanding, asked: l.asked } : {}),
      })),
    } : {}),
    ...(d.poStatus ? { po_status: d.poStatus } : {}),
    ...(d.existing ? { existing_goods_received: { id: d.existing.id, grn_number: d.existing.grnNumber } } : {}),
    ...(d.bills ? { bills: d.bills.map((b) => ({ id: b.id, invoice_number: b.invoiceNumber })), bills_total: d.billsTotal } : {}),
  }));
}

/** Runs the real service live, or in a savepoint that is always rolled back. A GoodsReceivedError is the answer; anything else throws. */
export async function runGrn<T>(name: string, dryRun: boolean, fn: () => Promise<T>): Promise<{ value: T } | McpToolResult> {
  try {
    if (!dryRun) return { value: await fn() };
    let value: T | undefined;
    await inRolledBackSavepoint(name, async () => { value = await fn(); });
    return { value: value as T };
  } catch (err) {
    if (err instanceof GoodsReceivedError) return grnRefusal(err, dryRun);
    throw err;
  }
}

export const isGrnToolResult = (r: unknown): r is McpToolResult => typeof r === 'object' && r !== null && 'content' in r;

/** A dry run's answer: the live body, flagged, nothing written, the key left free. */
export function grnDryRunResult(body: Record<string, unknown>): McpToolResult {
  const preview = ok({ dry_run: true, ...body });
  preview.wroteNothing = true;
  preview.billable = false;
  return preview;
}
