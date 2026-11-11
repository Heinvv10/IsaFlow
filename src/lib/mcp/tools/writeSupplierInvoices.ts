/**
 * MCP write tools: supplier invoices (AP).
 *
 * The connector had no AP write path at all — `create_draft_invoice` /
 * `finalize_invoice` are sales-side. Payables could only be forced in as
 * journals, which bypasses the supplier subledger entirely: `aged_creditors`
 * stays empty, nothing ages, and no payment can ever match to the document.
 *
 * `create_supplier_invoice` posts nothing (status stays `draft`), so it is
 * `write` but not `requiresPost`. `approve_supplier_invoice` is the AP mirror
 * of `finalize_invoice`: it posts DR Expense + DR VAT Input / CR AP to the
 * ledger and is irreversible, so it additionally requires `write:post`.
 */
import type { McpTool } from '../types';
import {
  createSupplierInvoice,
  getSupplierInvoiceById,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { recordBudgetRefusal } from '@/modules/accounting/services/budgets/budgetCheck';
import { BudgetExceededError } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { mayReadBudgetFigures } from './budgetFigures';
import { invoiceVatRefusals } from '@/modules/accounting/services/capture/capturedVatEvidence';
import { supplierBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { billLineAccountRefusal } from '@/modules/accounting/services/ap/billLineAccountGuard';
import { mcpPostingOpts } from '../mcpActor';
import { DIMENSION_LINE_PROPERTIES, itemsWithDimensions, supplierBillWarningsOrRefusal } from './dimensionArgs';
import { dueDateTermsWarnings } from './dueDateTermsWarning';
import { agentApprovalRefusal } from '@/modules/accounting/services/gl/approvalUnattended';
import { MAX_LINES, SUPPLIER_INVOICE_TEXT_LIMITS as TEXT_LIMITS, parseSupplierInvoiceInput } from './invoiceCreateArgs';
import {
  NOT_FOUND,
  guardCastableArgs,
  ok,
  safeErrorText,
  strArg,
  toolError,
} from './toolHelpers';
import { ALLOW_LATE_INPUT_CLAIM_PROP, allowLateInputClaim, lateClaimResult } from './lateClaimArg';

export const createSupplierInvoiceTool: McpTool = {
  name: 'create_supplier_invoice',
  description:
    'Create a DRAFT supplier invoice (bill / accounts payable document). Posts nothing to the ledger — use approve_supplier_invoice (needs write:post) to post DR Expense + DR VAT Input / CR Accounts Payable. ' +
    'Line amounts are NET of VAT: tax_rate is applied on top of quantity x unit_price. A line with no gl_account_id posts to the company\'s default expense account. ' +
    'Resolve supplier_id with list_suppliers and gl_account_id with list_gl_accounts first.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string', description: 'Supplier UUID (from list_suppliers)' },
      invoice_number: {
        type: 'string',
        maxLength: TEXT_LIMITS.invoice_number,
        description: `The supplier's own invoice number. Refused over ${TEXT_LIMITS.invoice_number} characters.`,
      },
      invoice_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      due_date: { type: 'string', format: 'date', description: "When omitted: from this bill's own payment_terms when you give them ('netNN' or 'immediate'), else the supplier's terms (see list_suppliers), else the company's default terms. A given date is kept even where it differs from the supplier's own terms; that comes back in due_date_warnings. Omit it unless the supplier's document states it." },
      tax_rate: { type: 'number', description: 'Invoice-level VAT %, default 15. Per-line tax_rate overrides it.' },
      payment_terms: { type: 'string', maxLength: TEXT_LIMITS.payment_terms },
      reference: { type: 'string', maxLength: TEXT_LIMITS.reference },
      notes: { type: 'string' },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_LINES,
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'number', exclusiveMinimum: 0 },
            unit_price: { type: 'number', minimum: 0, description: 'NET of VAT' },
            tax_rate: { type: 'number', minimum: 0, maximum: 100 },
            gl_account_id: { type: 'string', description: 'Expense GL account UUID; defaults to the company default expense account' },
            ...DIMENSION_LINE_PROPERTIES,
          },
          required: ['description', 'quantity', 'unit_price'],
          additionalProperties: false,
        },
      },
      idempotency_key: { type: 'string' },
    },
    required: ['supplier_id', 'invoice_number', 'invoice_date', 'lines', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const parsed = parseSupplierInvoiceInput(args);
    if (typeof parsed === 'string') return toolError(parsed);

    // Ownership, batched, before the first write. supplier_id and
    // gl_account_id are plain foreign keys with no composite (id, company_id)
    // constraint, so the database never re-checks the tenant. NOT_FOUND for
    // the supplier: a distinct "belongs to another company" reply is an
    // existence oracle. The line-account check also refuses accounts a bill
    // line may not name (billLineAccountGuard.ts); the service repeats it.
    if (!(await supplierBelongsToCompany(ctx.companyId, parsed.supplierId))) {
      return toolError(NOT_FOUND);
    }
    const accountRefusal = await billLineAccountRefusal(ctx.companyId, parsed.accountIds);
    if (accountRefusal) return toolError(accountRefusal);
    // cc1/cc2/bu per line: resolved, CC1 derived from CC2, conflicts refused — all pre-write.
    const items = await itemsWithDimensions(ctx.companyId, parsed.items, parsed.dimensionRefs, (i) => `lines[${i}]`);
    if (typeof items === 'string') return toolError(items);
    const cos = await supplierBillWarningsOrRefusal(ctx.companyId, parsed.supplierId, items, (i) => `lines[${i}]`);
    if (typeof cos === 'string') return toolError(cos);
    // A given due_date is kept even where the supplier's terms disagree; the agent is told (dueDateTermsWarning.ts).
    const dueWarnings = await dueDateTermsWarnings(ctx.companyId, [
      { supplierId: parsed.supplierId, invoiceDate: parsed.invoiceDate, dueDate: parsed.dueDate, paymentTerms: parsed.paymentTerms, label: '' },
    ]);

    try {
      const invoice = await createSupplierInvoice(
        ctx.companyId,
        {
          supplierId: parsed.supplierId,
          invoiceNumber: parsed.invoiceNumber,
          invoiceDate: parsed.invoiceDate,
          dueDate: parsed.dueDate,
          taxRate: parsed.taxRate,
          paymentTerms: parsed.paymentTerms,
          reference: parsed.reference,
          notes: parsed.notes,
          items,
        },
        ctx.userId,
        mcpPostingOpts(ctx, 'create_supplier_invoice'),
      );
      return ok({
        id: invoice.id,
        invoice_number: invoice.invoiceNumber,
        supplier_id: invoice.supplierId,
        invoice_date: invoice.invoiceDate,
        due_date: invoice.dueDate ?? null,
        subtotal: invoice.subtotal,
        tax_amount: invoice.taxAmount,
        total_amount: invoice.totalAmount,
        status: invoice.status,
        ...(cos.warnings.length > 0 ? { dimension_warnings: cos.warnings } : {}),
        ...(dueWarnings.length > 0 ? { due_date_warnings: dueWarnings } : {}),
      });
    } catch (err) {
      // The service's own validation (quantity, unit price) fires before its
      // INSERT, so surfacing the message keeps nothing written. Anything with
      // a SQLSTATE generic-ifies rather than leaking schema.
      return toolError(safeErrorText(err, 'Failed to create supplier invoice.'));
    }
  },
};

export const approveSupplierInvoiceTool: McpTool = {
  name: 'approve_supplier_invoice',
  description:
    'Approve a DRAFT supplier invoice and POST it to the ledger — DR Expense (per line) + DR VAT Input / CR Accounts Payable. Irreversible except by a reversing entry. Requires the write:post permission. ' +
    'The invoice must be in draft or pending_approval; anything else is refused with its current status. '
    + 'Budget check: under the company\'s block policy a bill over its remaining budget, or with a line outside every budgeted slice of a budgeted account (e.g. no cost centre where the account is budgeted per cost centre), is refused (BUDGET_EXCEEDED, naming each line; an agent cannot override); under warn it posts and those lines come back as budget_warnings.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string' },
      idempotency_key: { type: 'string' },
      allow_late_input_claim: ALLOW_LATE_INPUT_CLAIM_PROP,
    },
    required: ['invoice_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const invoiceId = strArg(args, 'invoice_id');
    if (!invoiceId) return toolError('invoice_id is required');
    const bad = guardCastableArgs(args, { uuid: ['invoice_id'] });
    if (bad) return bad;

    // Both refusals are answered from a READ so the service call below needs
    // no catch. approveSupplierInvoice raises the status one itself, but a
    // `catch -> toolError` cannot tell it from a failure after the journal was
    // posted — and a refusal is audited with a NULL idempotency key, so the
    // agent's retry on that key would post the invoice a second time.
    const invoice = await getSupplierInvoiceById(ctx.companyId, invoiceId);
    if (!invoice) return toolError(NOT_FOUND);
    if (invoice.status !== 'draft' && invoice.status !== 'pending_approval') {
      return toolError(`Cannot approve invoice with status: ${invoice.status}`);
    }
    // R-035 (Q6): a bill an enforced approval rule governs is refused from this
    // read too — an agent can neither raise nor decide the approval it needs.
    const approvalRefusal = await agentApprovalRefusal(ctx.companyId, 'supplier_invoice', invoiceId);
    if (approvalRefusal) return toolError(approvalRefusal);
    // K-072 r30–r36: a VAT the captured document never showed, or a meals merchant's VAT, is not an agent's to post.
    const vatRefusal = (await invoiceVatRefusals(ctx.companyId, [invoiceId])).get(invoiceId);
    if (vatRefusal) return toolError(`Cannot approve invoice: ${vatRefusal}.`);

    // No catch: a missing system account, a closed period or a database
    // failure must reach the registry's savepoint rather than being flattened
    // into a tool error that keeps a partially posted journal.
    //
    // The stamp is what puts this entry in list_agent_postings. Without it
    // createJournalEntry falls back to defaultHumanMeta(userId), labelling
    // agent work as the token owner's own.
    //
    // The ONE catch (budgets P5-2): a BUDGET_EXCEEDED refusal (block policy) is raised before approve's first
    // write and approve's own savepoint has already rolled back, so nothing of the approval is left. Its `refused`
    // event must outlive the registry's savepoint, so it is recorded here and answered as a refusal (census finding 4).
    // An agent cannot override; warn-mode overspend proceeds and comes back as `budget_warnings`.
    let updated: Awaited<ReturnType<typeof approveSupplierInvoice>>;
    try {
      updated = await approveSupplierInvoice(ctx.companyId, invoiceId, ctx.userId, {
        ...mcpPostingOpts(ctx, 'approve_supplier_invoice'),
        allowLateInputClaim: allowLateInputClaim(args),
        budget: { channel: 'mcp', lock: 'take', figures: mayReadBudgetFigures(ctx) },
      });
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      await recordBudgetRefusal(err);
      return toolError(`${err.code}: ${err.message}`);
    }

    return ok({
      id: updated.id,
      invoice_number: updated.invoiceNumber,
      status: updated.status,
      total_amount: updated.totalAmount,
      gl_journal_entry_id: updated.glJournalEntryId ?? null,
      late_claim: lateClaimResult(updated.lateClaim),
      ...(updated.warnings ? { warnings: updated.warnings } : {}), // a cost-centre pick the posting dropped
      ...(updated.budgetWarnings ? { budget_warnings: updated.budgetWarnings } : {}), // P5-2: approved over budget (warn)
    });
  },
};
