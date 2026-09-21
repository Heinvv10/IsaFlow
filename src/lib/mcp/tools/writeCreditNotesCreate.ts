/**
 * MCP write tool: CREATING a draft credit note.
 *
 * Split from writeCreditNotes.ts for the 300-line cap in CLAUDE.md; the seam is
 * the ledger. Nothing here posts — a created note stays `draft` — while approve
 * and cancel next door both move the GL and apply or un-apply the credit.
 *
 * `writeCreditNotes` re-exports this tool, so the registry and every test keep
 * one import surface.
 */
import type { McpTool } from '../types';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import {
  validateCreditNoteLinks,
  findOpenDuplicateDraft,
} from '@/modules/accounting/services/ar/creditNoteLinkService';
import { mcpPostingOpts } from '../mcpActor';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TYPES = ['customer', 'supplier'] as const;

export const createCreditNoteTool: McpTool = {
  name: 'create_credit_note',
  description:
    'Create a DRAFT credit note. Posts nothing to the ledger — use approve_credit_note (needs write:post) to post it. ' +
    'type "customer" credits a customer and needs client_id (from list_customers); type "supplier" credits a supplier bill and needs supplier_id (from list_suppliers). ' +
    'subtotal is NET of VAT and must be positive — tax_rate (default 15) is applied on top, and total = subtotal + VAT. ' +
    'Optionally link the note to the invoice it corrects with customer_invoice_id / supplier_invoice_id; a LINKED note is AUTO-APPLIED at approve, reducing that invoice\'s outstanding balance by up to its outstanding amount. Leave the link out to raise standalone credit. ' +
    'An identical open draft (same counterparty, linked invoice, date and amount) is REFUSED and its id returned — retrying with a new idempotency_key will not create a second one. ' +
    'When it is genuinely a SECOND credit (two returns on one day for one amount), pass allow_duplicate: true.',
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
      allow_duplicate: {
        type: 'boolean',
        description: 'true only when an identical open draft exists and this is genuinely a second, separate credit.',
      },
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
    //
    // A legitimate duplicate reaches this tool too — two returns on one day for
    // one amount — and `reason` is not part of the key (an agent regenerating
    // its reason text on a retry would slip past it). Without an override the
    // only way through was to alter the date or amount: falsify the document to
    // pass the guard. allow_duplicate is that override, and only boolean `true`
    // opens it. The same idempotency_key still replays a blind retry.
    const taxRateForTotal = taxRate ?? 15;
    const total = Math.round(subtotal * (1 + taxRateForTotal / 100) * 100) / 100;
    const duplicate = args.allow_duplicate === true ? null : await findOpenDuplicateDraft(
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
        + 'linked invoice, date and amount. If this is a retry, approve that one with approve_credit_note. '
        + 'If it is genuinely a second, separate credit, call again with allow_duplicate: true.',
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

