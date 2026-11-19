/**
 * MCP write tool: update_purchase_order — change a purchase order's header and/or REPLACE all its lines (design:
 * docs/design/mcp-po-maintenance.md, decision 1). Draft, submitted (as the app's edit) or approved. Posts NOTHING.
 *
 * Contract:
 *   - Refused when the PO has a goods receipt or a bill tied to it (a link, a bill line naming one of its lines, a bill whose header
 *     names it): replacing the lines would orphan them. A supplier change on a linked PO is refused as well.
 *   - An APPROVED PO's edit (lines replaced, or the order date moved) re-runs the Approve action's budget check on the new lines
 *     under the budget gate: block refuses and rolls the edit back, warn returns budget_warnings.
 *   - Totals are recomputed from the lines in cents (the import's rules: the source's own line_total / tax_amount stored as sent);
 *     expected_totals, when sent, must equal them to the cent. Lines may name an item by item_id or item_code.
 *   - dry_run runs the real service in a rolled-back savepoint and writes nothing (the key stays free).
 */
import type { McpTool } from '../types';
import { canCancelApprovedPo } from '@/lib/auth/writeRoles';
import { APPROVED_EDIT_REFUSAL, updatePurchaseOrder, type PoUpdateResult } from '@/modules/accounting/services/ap/purchaseOrderUpdate';
import { mayReadBudgetFigures } from './budgetFigures';
import { DIMENSION_LINE_PROPERTIES } from './dimensionArgs';
import { MAX_LINES } from './invoiceCreateArgs';
import { dryRunNeedsTx, dryRunResult, isToolResult, readPoStatus, resolvePoId, runMaintenance } from './purchaseOrderMaintenanceArgs';
import { PO_TEXT_LIMITS } from './purchaseOrderImportArgs';
import { parseUpdateArgs } from './purchaseOrderUpdateArgs';
import { prepareUpdate } from './purchaseOrderUpdatePrepare';
import { ok, toolError } from './toolHelpers';

const TOOL = 'update_purchase_order';
const money = { type: 'number', minimum: 0 } as const;

const LINE_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', maxLength: PO_TEXT_LIMITS.description },
    quantity: { type: 'number', exclusiveMinimum: 0, description: 'At most 2 decimals.' },
    unit_price: { type: 'number', minimum: 0, description: 'Ex-VAT unit price, any precision.' },
    tax_rate: { type: 'number', minimum: 0, maximum: 100, description: 'VAT %. Default: the item\'s VAT type when the line names an item, else 15.' },
    line_total: { ...money, description: "The source's own ex-VAT line amount (after any discount). Stored as sent; never more than quantity x unit_price." },
    tax_amount: { ...money, description: "The source's own VAT on the line. Only with line_total; must agree with it at tax_rate within 2 cents." },
    gl_account_id: { type: 'string', description: 'Expense GL account UUID (list_gl_accounts). With an item and none, the item\'s purchases account.' },
    item_id: { type: 'string', description: 'Catalogue item UUID (list_items).' },
    item_code: { type: 'string', maxLength: 100, description: 'Catalogue item code, instead of item_id.' },
    ...DIMENSION_LINE_PROPERTIES,
  },
  required: ['description', 'quantity', 'unit_price'],
  additionalProperties: false,
} as const;

function body(r: PoUpdateResult, warnings: readonly string[]) {
  return {
    po_id: r.poId, po_number: r.poNumber, status: r.status, changed_fields: r.changedFields, lines_replaced: r.linesReplaced,
    subtotal: r.subtotal, tax_amount: r.taxAmount, total: r.total, budget_checked: r.budgetChecked,
    budget_warning: r.budgetWarnings.length > 0 ? r.budgetWarnings.join(' ') : null, budget_warnings: r.budgetWarnings,
    ...(warnings.length > 0 ? { dimension_warnings: warnings } : {}),
  };
}

export const updatePurchaseOrderTool: McpTool = {
  name: TOOL,
  description:
    'Edit a purchase order (po_id or po_number): header fields (supplier_id, order_date, delivery_date, reference, notes; leave out = unchanged, null clears reference / notes / delivery_date) '
    + 'and/or lines, which REPLACE every line (lines left out keep the lines and the totals). Allowed on a draft or submitted purchase order by any writer, and on an APPROVED one by an owner or admin only (it changes what the PO commits; the approver is then restamped to the editor and the previous one kept in the audit trail); a partially_received, received, closed or cancelled one is refused with its status. Posts nothing to the ledger. '
    + 'Refused when goods have been received against the PO or any bill is tied to it (a link, a bill line on one of its lines, or a bill naming it): unlink the bills (unlink_bill_from_purchase_order) or cancel the receipt first, and its supplier cannot change while bills are linked. '
    + 'Totals are recomputed from the lines; send expected_totals (subtotal / tax_amount / total) to have them checked to the cent. A line may send the source\'s line_total / tax_amount, and name an item by item_id or item_code (no account sent: the item\'s purchases account; no tax_rate: the item\'s VAT type). '
    + 'Each line has exactly the cc1 / cc2 / bu it names. Editing an APPROVED PO\'s lines or order date re-runs the PO approval budget check on the new lines: under the block policy an over-budget edit is refused and nothing changes (and every new line needs an expense account: a line with none cannot be budget-checked); under warn it succeeds and returns budget_warnings. The check judges the new lines in the order date\'s month. A draft is not checked. '
    + 'dry_run runs every check (the real edit in a rolled-back savepoint) and writes nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      po_id: { type: 'string', description: 'Purchase order UUID; or give po_number' },
      po_number: { type: 'string', maxLength: 50, description: 'e.g. "PO0000197"; or give po_id' },
      supplier_id: { type: 'string', description: 'Supplier UUID (list_suppliers). Refused while bills are linked.' },
      order_date: { type: 'string', format: 'date' },
      delivery_date: { type: ['string', 'null'], format: 'date' },
      reference: { type: ['string', 'null'], maxLength: PO_TEXT_LIMITS.reference },
      notes: { type: ['string', 'null'], maxLength: PO_TEXT_LIMITS.notes },
      inclusive: { type: 'boolean', description: 'The new lines\' prices included VAT (only changes computed amounts).' },
      expected_totals: { type: 'object', properties: { subtotal: money, tax_amount: money, total: money }, additionalProperties: false },
      lines: { type: 'array', minItems: 1, maxItems: MAX_LINES, items: LINE_SCHEMA, description: 'REPLACES every line.' },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome; write nothing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const parsed = parseUpdateArgs(args);
    if (typeof parsed === 'string') return toolError(parsed);
    const needsTx = dryRunNeedsTx(parsed.dryRun);
    if (needsTx) return toolError(needsTx);
    // Editing an APPROVED PO is the owner's / admin's call (it changes what the PO commits): refused after one status read, before the
    // edit is validated or anything is locked, dry run too. The service decides again under its lock.
    const mayEditApproved = canCancelApprovedPo(ctx.companyRole);
    if (!mayEditApproved) {
      const id = await resolvePoId(ctx.companyId, parsed);
      if (id && (await readPoStatus(ctx.companyId, id)) === 'approved') return toolError(`${APPROVED_EDIT_REFUSAL}.`);
    }
    const prepared = await prepareUpdate(ctx.companyId, parsed);
    if (typeof prepared === 'string') return toolError(prepared);

    const out = await runMaintenance(`${TOOL}_dry`, parsed.dryRun, () => updatePurchaseOrder(ctx.companyId, prepared.request, {
      userId: ctx.userId, via: `mcp:${TOOL}`, budgetFigures: mayReadBudgetFigures(ctx), mayEditApproved,
    }));
    if (isToolResult(out)) return out;
    return parsed.dryRun ? dryRunResult({ would_update: true, ...body(out.value, prepared.warnings) }) : ok({ updated: true, ...body(out.value, prepared.warnings) });
  },
};
