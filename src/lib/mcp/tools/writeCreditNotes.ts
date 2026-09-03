/**
 * MCP write tools: credit notes (AR and AP).
 *
 * `create_credit_note` posts nothing (status stays `draft`), so it is `write`
 * but not `requiresPost`. `approve_credit_note` and `cancel_credit_note` both
 * move the ledger and additionally require `write:post`:
 *
 *   customer note  approve → DR Revenue + DR VAT Output / CR Accounts Receivable
 *   supplier note  approve → DR Accounts Payable / CR Expense + CR VAT Input
 *   cancel         → reverses that journal and un-applies the invoice credit
 *
 * The sharp edge worth knowing before reading further: approving a note that
 * carries an invoice link does NOT stop at the ledger. `approveCreditNote`
 * also adds the note's total to that invoice's `amount_paid` and lands the note
 * in `applied` rather than `approved`. So one `approve_credit_note` call can
 * reduce a customer's outstanding balance — which is why it sits behind
 * `write:post` and is stamped for `list_agent_postings`.
 */
import type { McpTool } from '../types';
import {
  createCreditNote,
  approveCreditNote,
  cancelCreditNote,
  getCreditNoteById,
} from '@/modules/accounting/services/ar/creditNoteService';
import {
  validateCreditNoteLinks,
  findOpenDuplicateDraft,
} from '@/modules/accounting/services/ar/creditNoteLinkService';
import { validateSystemAccounts } from '@/modules/accounting/services/gl/systemAccountResolver';
import { mcpPostingOpts } from '../mcpActor';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TYPES = ['customer', 'supplier'] as const;

export const createCreditNoteTool: McpTool = {
  name: 'create_credit_note',
  description:
    'Create a DRAFT credit note. Posts nothing to the ledger — use approve_credit_note (needs write:post) to post it. ' +
    'type "customer" credits a customer and needs client_id (from list_customers); type "supplier" credits a supplier bill and needs supplier_id (from list_suppliers). ' +
    'subtotal is NET of VAT and must be positive — tax_rate (default 15) is applied on top, and total = subtotal + VAT. ' +
    'Optionally link the note to the invoice it corrects with customer_invoice_id / supplier_invoice_id; a LINKED note is AUTO-APPLIED at approve, reducing that invoice\'s outstanding balance by up to its outstanding amount. Leave the link out to raise standalone credit. ' +
    'An identical open draft (same counterparty, date and amount) is REFUSED and its id returned — retrying with a new idempotency_key will not create a second one.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...TYPES] },
      client_id: { type: 'string', description: 'Customer UUID — required when type is "customer"' },
      supplier_id: { type: 'string', description: 'Supplier UUID — required when type is "supplier"' },
      customer_invoice_id: { type: 'string', description: 'Invoice this note credits; auto-applied at approve' },
      supplier_invoice_id: { type: 'string', description: 'Supplier invoice this note credits; auto-applied at approve' },
      credit_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      subtotal: { type: 'number', exclusiveMinimum: 0, description: 'NET of VAT' },
      tax_rate: { type: 'number', minimum: 0, maximum: 100, description: 'VAT %, default 15' },
      reason: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['type', 'credit_date', 'subtotal', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const type = strArg(args, 'type');
    if (!type || !TYPES.includes(type as (typeof TYPES)[number])) {
      return toolError(`type must be one of: ${TYPES.join(', ')}`);
    }
    const creditDate = strArg(args, 'credit_date');
    if (!creditDate) return toolError('credit_date is required (YYYY-MM-DD)');

    const bad = guardCastableArgs(args, {
      uuid: ['client_id', 'supplier_id', 'customer_invoice_id', 'supplier_invoice_id'],
      date: ['credit_date'],
    });
    if (bad) return bad;

    // Non-positive subtotals invert the note's GL at approve — a negative
    // credit note is an invoice wearing the wrong document type, and it would
    // pass every downstream balance check while moving the ledger the wrong
    // way. The REST route guards its line items for the same reason.
    const subtotal = Number(args.subtotal);
    if (!Number.isFinite(subtotal) || subtotal <= 0) {
      return toolError('subtotal must be a positive number (net of VAT)');
    }

    let taxRate: number | undefined;
    if (args.tax_rate !== undefined && args.tax_rate !== null) {
      taxRate = Number(args.tax_rate);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        return toolError('tax_rate must be between 0 and 100');
      }
    }

    const clientId = strArg(args, 'client_id');
    const supplierId = strArg(args, 'supplier_id');
    const customerInvoiceId = strArg(args, 'customer_invoice_id');
    const supplierInvoiceId = strArg(args, 'supplier_invoice_id');

    // Refuse the cross-type combinations here rather than letting them through
    // as NULLs: a customer note carrying supplier_invoice_id would be created
    // successfully and then approve into a journal with nothing to apply to.
    if (type === 'customer' && (supplierId || supplierInvoiceId)) {
      return toolError('A customer credit note cannot carry supplier_id or supplier_invoice_id');
    }
    if (type === 'supplier' && (clientId || customerInvoiceId)) {
      return toolError('A supplier credit note cannot carry client_id or customer_invoice_id');
    }

    // Tenant AND counterparty ownership, before the first write. Neither the
    // service nor the database re-checks either one — every id below is a bare
    // foreign key with no (id, company_id) constraint — so this is the only
    // thing standing between a foreign UUID and a cross-tenant document, or a
    // note that pays down the wrong counterparty's invoice at approve.
    const linkError = await validateCreditNoteLinks(ctx.companyId, {
      type: type as (typeof TYPES)[number],
      clientId,
      supplierId,
      customerInvoiceId,
      supplierInvoiceId,
    });
    if (linkError) return toolError(linkError);

    // Natural-key dedupe, agent-boundary only.
    //
    // The registry replays only on the SAME idempotency key, and an agent whose
    // call times out routinely retries with a fresh one — so nothing otherwise
    // stops an identical second draft. Refusing beats warning: two drafts are
    // harmless until both are approved, and then they are two journals and two
    // credits against one invoice, which is precisely the pair nobody notices.
    // The reply names the existing note so the agent can approve THAT one, and
    // a genuinely distinct second note differs in date, amount or reason.
    //
    // Deliberately not in the service: the REST route backs a form where a
    // person can see their own draft list, and refusing there would obstruct a
    // legitimate duplicate. The blind retry is an agent problem.
    const taxRateForTotal = taxRate ?? 15;
    const total = Math.round(subtotal * (1 + taxRateForTotal / 100) * 100) / 100;
    const duplicate = await findOpenDuplicateDraft(
      ctx.companyId,
      {
        type: type as (typeof TYPES)[number],
        clientId, supplierId, customerInvoiceId, supplierInvoiceId,
        creditDate,
      },
      total,
    );
    if (duplicate) {
      return toolError(
        `An identical draft credit note already exists (id ${duplicate}) for the same counterparty, `
        + 'date and amount. Approve that one with approve_credit_note, or change the date, amount or '
        + 'reason if this is genuinely a second credit.',
      );
    }

    const note = await createCreditNote(
      ctx.companyId,
      {
        type: type as (typeof TYPES)[number],
        clientId,
        supplierId,
        customerInvoiceId,
        supplierInvoiceId,
        creditDate,
        reason: strArg(args, 'reason'),
        subtotal,
        taxRate,
      },
      ctx.userId,
      // A draft note posts no journal, so the document row is the only place
      // the actor can be recorded until approval (migration 531).
      mcpPostingOpts(ctx, 'create_credit_note'),
    );

    return ok({
      id: note.id,
      credit_note_number: note.creditNoteNumber,
      type: note.type,
      status: note.status,
      subtotal: note.subtotal,
      tax_rate: note.taxRate,
      tax_amount: note.taxAmount,
      total_amount: note.totalAmount,
    });
  },
};

export const approveCreditNoteTool: McpTool = {
  name: 'approve_credit_note',
  description:
    'Approve a DRAFT credit note and POST it to the ledger. Requires the write:post permission. ' +
    'Customer note: DR Revenue + DR VAT Output / CR Accounts Receivable. Supplier note: DR Accounts Payable / CR Expense + CR VAT Input. ' +
    'If the note is linked to an invoice it is also AUTO-APPLIED — the invoice\'s amount_paid rises by the note total and the note lands in status "applied" instead of "approved". Reverse with cancel_credit_note.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['credit_note_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'credit_note_id');
    if (!id) return toolError('credit_note_id is required');
    const bad = guardCastableArgs(args, { uuid: ['credit_note_id'] });
    if (bad) return bad;

    // Both refusals are answered from a READ so the service call below needs no
    // catch. approveCreditNote raises the status one itself, but a
    // `catch -> toolError` cannot tell it from a failure AFTER the journal was
    // posted — and a refusal is audited with a NULL idempotency key, so the
    // agent's retry on that key would post the note a second time.
    const note = await getCreditNoteById(ctx.companyId, id);
    if (!note) return toolError(NOT_FOUND);
    if (note.status !== 'draft') {
      return toolError(`Cannot approve credit note with status: ${note.status}`);
    }

    // A missing system account is the likeliest reason an approve fails, and it
    // is the one an agent can actually do something about (create_gl_account
    // with the right subtype). Left to throw, it reaches the registry as
    // GENERIC_FAILURE naming nothing — so the agent retries the same call
    // forever against a company that will never be able to answer it. Refusing
    // here is pre-write and names the subtypes.
    const NEEDED = note.type === 'customer'
      ? ['default_revenue', 'receivable', 'vat_output']
      : ['payable', 'default_expense', 'vat_input'];
    const missing = (await validateSystemAccounts(ctx.companyId)).filter((k) => NEEDED.includes(k));
    if (missing.length > 0) {
      return toolError(
        `Cannot approve: this company has no GL account with subtype ${missing.join(', ')}. `
        + 'Create one with create_gl_account (needs the write:accounts permission), then retry.',
      );
    }

    // No catch beyond that: a closed period or a database failure must reach
    // the registry's savepoint rather than being flattened into a tool error
    // that keeps a partially posted journal.
    const updated = await approveCreditNote(ctx.companyId, id, ctx.userId, {
      ...mcpPostingOpts(ctx, 'approve_credit_note'),
    });

    return ok({
      id: updated.id,
      credit_note_number: updated.creditNoteNumber,
      type: updated.type,
      status: updated.status,
      total_amount: updated.totalAmount,
      gl_journal_entry_id: updated.glJournalEntryId ?? null,
      // 'applied' is the auto-apply having fired. Saying so explicitly stops an
      // agent reading 'approved' vs 'applied' as cosmetic and then looking for
      // a second apply step that would double-credit the invoice.
      applied_to_invoice_id:
        updated.status === 'applied'
          ? (updated.customerInvoiceId ?? updated.supplierInvoiceId ?? null)
          : null,
    });
  },
};

export const cancelCreditNoteTool: McpTool = {
  name: 'cancel_credit_note',
  description:
    'Cancel an approved or applied credit note. Requires the write:post permission. ' +
    'REVERSES the note\'s journal entry with a reversing entry (the original stays posted) and, for an applied note, un-applies the credit — the linked invoice\'s amount_paid drops back and its status is recomputed. ' +
    'Only "approved" and "applied" notes can be cancelled; a draft has nothing to reverse.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string' },
      reason: { type: 'string', description: 'Recorded on the note as cancel_reason' },
      idempotency_key: { type: 'string' },
    },
    required: ['credit_note_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'credit_note_id');
    if (!id) return toolError('credit_note_id is required');
    const bad = guardCastableArgs(args, { uuid: ['credit_note_id'] });
    if (bad) return bad;

    // Same reasoning as approve: refuse from a read, never from a catch.
    const note = await getCreditNoteById(ctx.companyId, id);
    if (!note) return toolError(NOT_FOUND);
    if (note.status !== 'approved' && note.status !== 'applied') {
      return toolError(`Cannot cancel credit note with status: ${note.status}`);
    }

    const updated = await cancelCreditNote(
      ctx.companyId,
      id,
      ctx.userId,
      strArg(args, 'reason'),
      mcpPostingOpts(ctx, 'cancel_credit_note'),
    );

    return ok({
      id: updated.id,
      credit_note_number: updated.creditNoteNumber,
      status: updated.status,
      total_amount: updated.totalAmount,
    });
  },
};
