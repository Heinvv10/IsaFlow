/**
 * MCP write tool: link_bills_to_purchase_order — record which bills were billed against which purchase orders, for up to
 * 200 (PO, bill) pairs, WITHOUT reposting a bill (design: docs/design/mcp-po-bill-links.md). POSTS NOTHING: no journal, and
 * a bill's status, totals and amount_paid are untouched.
 *
 * Contract:
 *   - ALL OR NOTHING with every bad row listed: a refusal (parse, ownership, status, supplier, an already-linked pair, a
 *     bill line already naming another PO line) refuses the call before the first write, `links[i]: reason` for each.
 *   - Idempotent on external_ref: the same pair under the same (external_system, external_ref) comes back
 *     already_existed and is not written again; a call that wrote nothing leaves the idempotency_key free.
 *   - dry_run runs the real service in a rolled-back savepoint (every guard, every figure) and writes nothing.
 *   - Locks: external-ref advisory locks, then PO rows in id order, then bill rows in id order, one 5 s budget.
 */
import type { McpTool } from '../types';
import { als } from '@/lib/als';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { canCancelApprovedPo } from '@/lib/auth/writeRoles';
import { linkBillsToPurchaseOrders, type LinkResult } from '@/modules/accounting/services/ap/purchaseOrderBillLink';
import {
  MAX_LINKS_PER_CALL, PurchaseOrderBillLinkRefusal, linkRefusalText,
} from '@/modules/accounting/services/ap/purchaseOrderBillLinkTypes';
import { parseLinkBatch } from './poBillLinkArgs';
import { MAX_LINES } from './invoiceCreateArgs';
import { ok, toolError } from './toolHelpers';
import { mayReadBudgetFigures } from './budgetFigures';

const TOOL = 'link_bills_to_purchase_order';
const r2 = (cents: number) => cents / 100;

const LINE_SCHEMA = {
  type: 'object',
  properties: {
    po_item_id: { type: 'string', description: 'A line of this purchase order (get_purchase_order lines[].id)' },
    bill_line_id: { type: 'string', description: 'A line of this bill (get_supplier_invoice items[].id)' },
  },
  required: ['po_item_id', 'bill_line_id'],
  additionalProperties: false,
} as const;

function wire(result: LinkResult, dry: boolean) {
  return {
    links: result.links.map((l) => ({
      index: l.index, link_id: dry && !l.alreadyExisted ? null : l.linkId, purchase_order_id: l.poId, po_number: l.poNumber, bill_id: l.billId,
      invoice_number: l.invoiceNumber, amount: r2(l.amountCents), lines_linked: l.linesLinked, already_existed: l.alreadyExisted, adopted_reference: l.adopted,
      external_system: l.externalSystem, external_ref: l.externalRef,
    })),
    purchase_orders: result.purchaseOrders.map((p) => ({
      id: p.poId, po_number: p.poNumber, status_before: p.statusBefore, status: p.statusAfter, closed_by_this_call: p.statusAfter !== p.statusBefore,
      billed: r2(p.billedCents), subtotal: r2(p.headerSubtotalCents), billing_basis: r2(p.subtotalCents), fully_billed: p.fullyBilled,
    })),
    budget_warnings: result.budgetWarnings,
  };
}

export const linkBillsToPurchaseOrderTool: McpTool = {
  name: TOOL,
  description:
    `Link bills (supplier invoices) to the purchase orders they were billed against: up to ${MAX_LINKS_PER_CALL} pairs per call. Posts NOTHING: no journal, and the bill's status, totals and amount_paid are untouched, so approved bills can be linked without reposting. `
    + 'Each link: po_id or po_number, bill_id, optional amount (ex-VAT billed against that PO; with lines it is the posted ex-VAT of the bill lines naming this PO and any other amount is refused, lines that post nothing are refused; without lines the default is the bill subtotal less what the bill already attributes to its other POs; when the bill\'s header names ANOTHER PO it holds the rest only as a residual: give an amount to take from it, and budget_warnings names that PO, which commits it again; no amount is refused), '
    + 'optional lines [{po_item_id, bill_line_id}] (whole bill line to whole PO line: budget committed nets those lines, and they feed the three-way match; a link with no lines nets committed by its amount, spread over the PO lines), '
    + 'and external_system + external_ref to make the link idempotent (the same pair under the same reference comes back already_existed). '
    + 'A bill may be linked to several purchase orders (split amounts); the amounts of one bill may not pass its subtotal. Same company and same supplier only. '
    + 'The PO must be approved, partially_received, received or closed; the bill approved, paid or partially_paid (a draft or cancelled bill is not billed). '
    + 'A pair already linked under the same external_ref is already_existed (refused with payload_differs when the amount or lines you send differ); a pair linked without a reference (made by the app) takes the external_ref you send (adopted_reference); any other repeat is refused (unlink_bill_from_purchase_order first). '
    + 'close_when_fully_billed: true (owner or admin only) moves an approved / partially_received / received PO to closed when its links on approved / paid / partially_paid bills reach its subtotal (within 1 cent); without it the PO status is left alone. Every PO in the reply reports fully_billed, judged against billing_basis (the larger of the header subtotal, reported as subtotal, and the lines\' total; a basis of 0 is never fully billed). '
    + 'Known limits: credit notes do not reduce what is billed; a header-only link reduces committed at the PO line, not on the bill\'s own account or month; '
    + 'a bill linked to several POs reads goods received only from its own grn_id, so it cannot be fully_matched across them. '
    + 'ALL OR NOTHING: every refused link is listed as links[i]: reason and nothing is written. dry_run runs every check and reports the outcome, writing nothing.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      links: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_LINKS_PER_CALL,
        items: {
          type: 'object',
          properties: {
            po_id: { type: 'string', description: 'Purchase order UUID (list_purchase_orders); or give po_number' },
            po_number: { type: 'string', maxLength: 50, description: 'e.g. "PO0000197"; or give po_id' },
            bill_id: { type: 'string', description: 'Supplier invoice UUID (list_supplier_invoices)' },
            amount: { type: 'number', exclusiveMinimum: 0, description: 'Ex-VAT amount billed against this PO, whole cents.' },
            lines: { type: 'array', minItems: 1, maxItems: MAX_LINES, items: LINE_SCHEMA },
            external_system: { type: 'string', maxLength: 32, description: 'e.g. "sage"; with external_ref' },
            external_ref: { type: ['string', 'integer'], description: 'The source system\'s id for this link (e.g. Sage FromDocument); with external_system' },
          },
          required: ['bill_id'],
          additionalProperties: false,
        },
      },
      close_when_fully_billed: { type: 'boolean', description: 'Close a fully billed approved / partially_received / received PO. Default false.' },
      dry_run: { type: 'boolean', description: 'Run every check and report the outcome; write nothing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['links', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const parsed = parseLinkBatch(args.links);
    if (typeof parsed === 'string') return toolError(parsed);
    if ('refusals' in parsed) return toolError(linkRefusalText(Array.isArray(args.links) ? args.links.length : 0, parsed.refusals));
    for (const flag of ['close_when_fully_billed', 'dry_run'] as const) {
      if (args[flag] !== undefined && typeof args[flag] !== 'boolean') return toolError(`${flag} must be true or false`);
    }
    // R1 (Hein, 19 Nov): closing a PO is the owner's / admin's call, as cancelling an approved one. Before any read, dry run too.
    if (args.close_when_fully_billed === true && !canCancelApprovedPo(ctx.companyRole)) {
      return toolError('close_when_fully_billed closes purchase orders, which only an owner or admin may do. Link without it, or ask an owner or admin.');
    }
    const dryRun = args.dry_run === true;
    // Outside a request transaction a savepoint is a plain call and the rollback below would undo nothing.
    if (dryRun && !als.getStore()?.client) return toolError('dry_run needs a request transaction');
    const opts = {
      userId: ctx.userId, source: 'mcp' as const, via: `mcp:${TOOL}`, closeWhenFullyBilled: args.close_when_fully_billed === true,
      budgetFigures: mayReadBudgetFigures(ctx),
    };

    let result: LinkResult | undefined;
    try {
      if (dryRun) await inRolledBackSavepoint('po_bill_link_dry', async () => { result = await linkBillsToPurchaseOrders(ctx.companyId, parsed.links, opts); });
      else result = await linkBillsToPurchaseOrders(ctx.companyId, parsed.links, opts);
    } catch (err) {
      if (err instanceof PurchaseOrderBillLinkRefusal) return toolError(err.message);
      throw err;
    }
    const done = result!;
    const created = done.links.filter((l) => !l.alreadyExisted).length;
    const adopted = done.links.filter((l) => l.adopted).length;
    if (dryRun) {
      const preview = ok({ dry_run: true, would_link: created, would_adopt_reference: adopted, already_existed: done.links.length - created, ...wire(done, true) });
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }
    const out = ok({ linked: created, adopted_reference: adopted, already_existed: done.links.length - created, ...wire(done, false) });
    // A re-run that found every pair already linked (and set no reference) wrote nothing: leave the key free, as a dry run does.
    if (created === 0 && adopted === 0) { out.wroteNothing = true; out.billable = false; }
    return out;
  },
};
