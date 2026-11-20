/**
 * Shared by the purchase-order maintenance tools (update / cancel / close / set status): the PO named by id or number resolved
 * inside the caller's company, the reason, and the typed refusals of the services answered as tool errors. Posts nothing.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als } from '@/lib/als';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { recordBudgetRefusal } from '@/modules/accounting/services/budgets/budgetCheck';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { PurchaseOrderNotCancellableError } from '@/modules/accounting/services/ap/purchaseOrderCancel';
import {
  PurchaseOrderChangedError, PurchaseOrderMaintenanceRefusal, PurchaseOrderNotFoundError,
} from '@/modules/accounting/services/ap/purchaseOrderErrors';
import type { McpToolResult } from '../types';
import { parsePoSelector } from './poBillLinkArgs';
import { NOT_FOUND, ok, toolError } from './toolHelpers';

export const REASON_MAX = 500;

/** The PO an `{ po_id | po_number }` names, this company's only; null when there is none (a foreign PO reads the same). */
export async function resolvePoId(companyId: string, po: { poId: string | null; poNumber: string | null }): Promise<string | null> {
  const rows = (await sql`
    SELECT id::TEXT AS id FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND (id = ${po.poId}::UUID OR po_number = ${po.poNumber}::TEXT)
  `) as DbRow[];
  return rows.length === 1 ? String(rows[0]!.id) : null;
}

/** The status of the PO an `{ po_id | po_number }` names (this company's only), or null. One read, no lock. */
export async function readPoStatus(companyId: string, poId: string): Promise<string | null> {
  const rows = (await sql`SELECT status FROM purchase_orders WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  return rows[0] ? String(rows[0].status) : null;
}

export interface MaintenanceArgs { poId: string | null; poNumber: string | null; reason: string; dryRun: boolean }

/** Selector, `reason` (required, audited) and `dry_run`, for the tools that carry them. */
export function parseMaintenanceArgs(args: Record<string, unknown>, extraKeys: readonly string[] = []): MaintenanceArgs | string {
  const allowed = new Set(['po_id', 'po_number', 'reason', 'dry_run', 'idempotency_key', ...extraKeys]);
  const stray = Object.keys(args).find((k) => !allowed.has(k));
  if (stray !== undefined) return `arguments.${stray} is not a field of this tool (allowed: ${[...allowed].join(', ')})`;
  const po = parsePoSelector(args, 'arguments');
  if (typeof po === 'string') return po;
  if (typeof args.reason !== 'string' || args.reason.trim() === '') return 'reason is required: say why (it is recorded in the audit trail)';
  if (args.reason.trim().length > REASON_MAX) return `reason is longer than ${REASON_MAX} characters`;
  if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') return 'dry_run must be true or false';
  return { ...po, reason: args.reason.trim(), dryRun: args.dry_run === true };
}

/** A dry run needs the request transaction its rollback undoes; outside it the savepoint is a plain call. Returns the refusal or null. */
export const dryRunNeedsTx = (dryRun: boolean): string | null => (dryRun && !als.getStore()?.client ? 'dry_run needs a request transaction' : null);

/**
 * Runs `fn` (the real service) for real, or inside a savepoint that is always rolled back. The services' typed refusals are the
 * tool's answer; a budget block on an approving write is recorded outside the rolled-back savepoint (live only) and answered as
 * `budget_exceeded:`; anything else is the registry's.
 */
export async function runMaintenance<T>(name: string, dryRun: boolean, fn: () => Promise<T>): Promise<{ value: T } | McpToolResult> {
  try {
    if (!dryRun) return { value: await fn() };
    let value: T | undefined;
    await inRolledBackSavepoint(name, async () => { value = await fn(); });
    return { value: value as T };
  } catch (err) {
    if (err instanceof PurchaseOrderMaintenanceRefusal || err instanceof PurchaseOrderNotCancellableError || err instanceof PurchaseOrderChangedError) {
      return toolError(err.message);
    }
    if (err instanceof PurchaseOrderNotFoundError) return toolError(NOT_FOUND);
    if (err instanceof BudgetExceededError) {
      if (!dryRun) await recordBudgetRefusal(err);
      return toolError(`budget_exceeded: ${err.message}`);
    }
    throw err;
  }
}

export const isToolResult = (r: unknown): r is McpToolResult => typeof r === 'object' && r !== null && 'content' in r;

/** A dry run's answer: the live body, flagged, nothing written, the key left free. */
export function dryRunResult(body: Record<string, unknown>): McpToolResult {
  const preview = ok({ dry_run: true, ...body });
  preview.wroteNothing = true;
  preview.billable = false;
  return preview;
}
