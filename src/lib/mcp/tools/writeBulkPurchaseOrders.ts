/**
 * MCP write tool: bulk_create_purchase_orders — load up to 100 purchase orders in one call with the source system's
 * own numbers (Velocity's Sage POs PO0000197..PO0000953 keep their numbers). Posts NOTHING: a PO is a commitment.
 *
 * Contract (design: docs/design/mcp-purchase-order-import.md):
 *   - ALL OR NOTHING. Parse and price every element, prove every id is this company's, then write inside one
 *     savepoint; a refusal anywhere (a number already in the books, a budget block, a lock timeout) leaves nothing.
 *   - Numbers are honoured exactly and never reissued: a number already on another PO of this company is refused.
 *   - Idempotent on external_ref: a PO already carrying (external_system, external_ref) comes back already_existed
 *     and is not written again, so re-sending a Sage page under a new idempotency_key is safe.
 *   - Totals: each PO's subtotal / VAT / total are the sums of its lines; expected_totals, when sent, must equal them
 *     to the cent. Lines may carry the source's own line_total / tax_amount (purchaseOrderImportAmounts).
 *   - Status: draft | open (= approved) | billed (= closed) | cancelled. Approved POs pass the Approve action's budget
 *     check (they then count as committed); closed and cancelled commit nothing.
 *   - The purchase_order number counter ends at least one past the highest imported number of its own form.
 *   - dry_run runs every step, reports the outcome and rolls it all back. Per PO it reports budget_check (the outcome the live
 *     check decides: ok / warn / block with its reasons) and dimension_warnings; a PO the live call would refuse on a block makes
 *     the preview would_succeed: false instead of failing it.
 *   - skip_budget_check_for_import (owner / admin only, refused before any read): an approved PO skips the block. The check
 *     still runs, so each approved PO reports budget_check_skipped and would_have_failed with its reasons (live and dry run), and
 *     its create audit row says so (design: docs/design/mcp-po-maintenance.md, decision 5).
 */
import type { McpTool } from '../types';
import { withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';
import { canCancelApprovedPo } from '@/lib/auth/writeRoles';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import {
  importPurchaseOrders, PurchaseOrderImportRefusal, type ImportedPo, type ImportResult,
} from '@/modules/accounting/services/ap/purchaseOrderImport';
import { mayReadBudgetFigures } from './budgetFigures';
import { DIMENSION_LINE_PROPERTIES } from './dimensionArgs';
import { EXTERNAL_REF_CREATE_PROPS } from './externalRef';
import { MAX_LINES } from './invoiceCreateArgs';
import {
  IMPORT_STATUS_ALIASES, MAX_PURCHASE_ORDERS, PO_TEXT_LIMITS, parsePurchaseOrderBatch,
} from './purchaseOrderImportArgs';
import { preparePurchaseOrders, type Prepared } from './purchaseOrderImportPrepare';
import { ok, toolError } from './toolHelpers';

const TOOL = 'bulk_create_purchase_orders';

class DryRunRollback extends Error {
  constructor(readonly result: ImportResult) { super('dry run'); }
}

const money = { type: 'number', minimum: 0 } as const;

/** Each PO as returned, with its own dimension_warnings; a dry run has no ids yet. */
function perPo(pos: readonly ImportedPo[], prepared: Prepared, dry: boolean) {
  return pos.map((p) => {
    const warnings = prepared.warningsByIndex.get(p.index);
    if (p.already_existed) return p;
    return { ...p, ...(dry ? { id: null } : {}), ...(warnings ? { dimension_warnings: warnings } : {}) };
  });
}

const budgetList = (pos: readonly ImportedPo[]) => pos.map((p) => ({ index: p.index, po_number: p.po_number, reasons: p.budget_check?.reasons ?? [] }));

/** skip_budget_check_for_import: which approved POs the block would have refused (live and dry run). */
function skipReport(pos: readonly ImportedPo[], skip: boolean) {
  if (!skip) return {};
  return { skip_budget_check_for_import: true, would_have_failed: budgetList(pos.filter((p) => p.budget_check?.would_have_failed === true)) };
}

const LINE_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', maxLength: PO_TEXT_LIMITS.description },
    quantity: { type: 'number', exclusiveMinimum: 0, description: 'At most 2 decimals.' },
    unit_price: { type: 'number', minimum: 0, description: 'Ex-VAT unit price, any precision. The PO line stores the effective price (line amount / quantity, 6 decimals).' },
    tax_rate: { type: 'number', minimum: 0, maximum: 100, description: 'VAT %, default 15.' },
    line_total: { ...money, description: "The source's own ex-VAT line amount (Sage Exclusive, after any discount). Stored as sent; never more than quantity x unit_price." },
    tax_amount: { ...money, description: "The source's own VAT on the line (Sage Tax). Only with line_total; must agree with it at tax_rate within 2 cents." },
    gl_account_id: { type: 'string', description: 'Expense GL account UUID (list_gl_accounts). A line without one is "No budget".' },
    ...DIMENSION_LINE_PROPERTIES,
  },
  required: ['description', 'quantity', 'unit_price'],
  additionalProperties: false,
} as const;

export const bulkCreatePurchaseOrdersTool: McpTool = {
  name: TOOL,
  description:
    `Create up to ${MAX_PURCHASE_ORDERS} purchase orders in ONE call with YOUR OWN po_number (honoured exactly: a migration keeps its numbers). Posts nothing to the ledger. `
    + 'ALL OR NOTHING: a po_number that already exists in this company refuses the whole batch, as does any other fault; nothing is written. '
    + 'Idempotent on external_ref (+ external_system): a PO already carrying it comes back already_existed: true and is not written again, so a re-run is safe. '
    + `status: ${Object.keys(IMPORT_STATUS_ALIASES).join(' | ')} (open = approved, billed = closed). Map Sage Pending/Overdue -> open, Invoiced -> billed, Cancelled -> cancelled. `
    + 'An open (approved) PO is budget-checked as the Approve action does and then counts as committed spend; billed (closed) and cancelled POs commit nothing. '
    + 'Each PO\'s totals are the sums of its lines; send expected_totals (the source\'s subtotal / tax_amount / total) to have them checked to the cent. '
    + 'Send each line\'s line_total and tax_amount from the source to store its exact figures; otherwise they are computed from quantity x unit_price (inclusive: true computes VAT the way an inclusive document does). '
    + 'Afterwards the purchase_order number counter is at least one past the highest imported number, so the next PO made in the app does not collide. '
    + 'Attach each PO\'s PDF with create_upload_urls / finalize_uploads or attach_entity_document (entity_type purchase_order). '
    + 'dry_run reports the outcome and writes nothing: per PO its budget_check (outcome ok / warn / block with the reasons, as the live check will decide) and dimension_warnings; a PO the live call would refuse on a block makes it would_succeed: false. '
    + 'skip_budget_check_for_import: true (owner or admin only) lets an open (approved) PO through a budget BLOCK: the check still runs and each open PO reports budget_check_skipped and would_have_failed with its reasons, in the live and the dry run, and the audit row of each PO records it.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      purchase_orders: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PURCHASE_ORDERS,
        items: {
          type: 'object',
          properties: {
            po_number: { type: 'string', maxLength: PO_TEXT_LIMITS.po_number, description: 'e.g. "PO0000197"' },
            supplier_id: { type: 'string', description: 'Supplier UUID (list_suppliers)' },
            order_date: { type: 'string', format: 'date' },
            delivery_date: { type: 'string', format: 'date' },
            reference: { type: 'string', maxLength: PO_TEXT_LIMITS.reference },
            notes: { type: 'string', maxLength: PO_TEXT_LIMITS.notes },
            status: { type: 'string', enum: Object.keys(IMPORT_STATUS_ALIASES), description: 'Default draft.' },
            inclusive: { type: 'boolean', description: 'The source document\'s prices included VAT (only changes computed amounts).' },
            ...EXTERNAL_REF_CREATE_PROPS,
            expected_totals: {
              type: 'object',
              properties: { subtotal: money, tax_amount: money, total: money },
              additionalProperties: false,
            },
            lines: { type: 'array', minItems: 1, maxItems: MAX_LINES, items: LINE_SCHEMA },
          },
          required: ['po_number', 'supplier_id', 'order_date', 'lines'],
          additionalProperties: false,
        },
      },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome; write nothing.' },
      skip_budget_check_for_import: { type: 'boolean', description: 'Owner / admin only. Approved POs skip the budget block; the response and the audit row say which would have failed.' },
      idempotency_key: { type: 'string' },
    },
    required: ['purchase_orders', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (args.skip_budget_check_for_import !== undefined && typeof args.skip_budget_check_for_import !== 'boolean') return toolError('skip_budget_check_for_import must be true or false');
    // Skipping a budget block is the owner's / admin's call (as closing a PO): refused before anything is read, dry run too.
    const skipBudget = args.skip_budget_check_for_import === true;
    if (skipBudget && !canCancelApprovedPo(ctx.companyRole)) {
      return toolError('skip_budget_check_for_import lets purchase orders past the budget check, which only an owner or admin may do. Import without it, or ask an owner or admin.');
    }
    const batch = parsePurchaseOrderBatch(args.purchase_orders);
    if (typeof batch === 'string') return toolError(batch);
    const dryRun = args.dry_run === true;
    // Outside a request transaction a savepoint is a plain call and the rollback below would undo nothing.
    if (dryRun && !als.getStore()?.client) return toolError('dry_run needs a request transaction');
    const prepared = await preparePurchaseOrders(ctx.companyId, batch);
    if (typeof prepared === 'string') return toolError(prepared);

    let result: ImportResult;
    try {
      result = await withSavepoint('po_import', async () => {
        const r = await importPurchaseOrders(ctx.companyId, prepared.items, {
          userId: ctx.userId, source: `mcp:${TOOL}`, budgetFigures: mayReadBudgetFigures(ctx), dryRun, skipBudgetCheck: skipBudget,
        });
        if (dryRun) throw new DryRunRollback(r);
        return r;
      });
    } catch (err) {
      if (err instanceof DryRunRollback) {
        const pos = err.result.purchaseOrders;
        const blocked = pos.filter((p) => p.budget_check?.outcome === 'block' && !p.budget_check.skipped);
        const preview = ok({
          dry_run: true,
          would_succeed: blocked.length === 0,
          would_create: pos.filter((p) => !p.already_existed).length,
          already_existed: pos.filter((p) => p.already_existed).length,
          purchase_orders: perPo(pos, prepared, true),
          ...(blocked.length > 0 ? { budget_blocked: budgetList(blocked) } : {}),
          ...skipReport(pos, skipBudget),
          counter_after: err.result.counter,
          ...(prepared.warnings.length > 0 ? { dimension_warnings: prepared.warnings } : {}),
        });
        preview.wroteNothing = true;
        preview.billable = false;
        return preview;
      }
      if (err instanceof PurchaseOrderImportRefusal) return toolError(err.message);
      if (err instanceof BudgetExceededError) return toolError(`budget_exceeded: ${err.message} Nothing was created; import that PO as draft and approve it in the app, or raise the budget.`);
      throw err;
    }

    const created = result.purchaseOrders.filter((p) => !p.already_existed).length;
    const out = ok({
      created,
      already_existed: result.purchaseOrders.length - created,
      purchase_orders: perPo(result.purchaseOrders, prepared, false),
      ...skipReport(result.purchaseOrders, skipBudget),
      counter: result.counter,
      ...(prepared.warnings.length > 0 ? { dimension_warnings: prepared.warnings } : {}),
    });
    // A re-run that found every PO already there (and left the counter where it was) wrote nothing: leave the key
    // free, as a dry run does.
    if (created === 0 && !result.counter.raised) { out.wroteNothing = true; out.billable = false; }
    return out;
  },
};
