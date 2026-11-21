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
import { creditNoteVatAndTotal, storedCreditNoteRate, typedCreditNoteVat } from '@/modules/accounting/services/ar/creditNoteTypedVat';
import { EXTERNAL_REF_CREATE_PROPS, createReplayOrLock, parseCreateRef, stampCreated } from './externalRef';
import {
  validateCreditNoteLinks,
  findOpenDuplicateDraft,
} from '@/modules/accounting/services/ar/creditNoteLinkService';
import { planMirroredSupplierNote } from '@/modules/accounting/services/ap/supplierCreditNoteMirror';
import { mcpPostingOpts } from '../mcpActor';
import { MIRROR_ARG_SCHEMA, mirrorReply, readMirrorArgs } from './creditNoteMirrorArgs';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { MCP_MONEY_FIELDS, creditNoteMoneyProblem } from '@/modules/accounting/services/ar/creditNoteRequestMoney';

const TYPES = ['customer', 'supplier'] as const;

export const createCreditNoteTool: McpTool = {
  name: 'create_credit_note',
  description:
    'Create a DRAFT credit note. Posts nothing to the ledger — use approve_credit_note (needs write:post) to post it. ' +
    'type "customer" credits a customer and needs client_id (from list_customers); type "supplier" credits a supplier bill and needs supplier_id (from list_suppliers). ' +
    'subtotal is NET of VAT and must be positive — tax_rate (default: the linked invoice\'s or bill\'s rate, else the standard rate on credit_date) is applied on top, and total = subtotal + VAT. ' +
    'Optionally link the note to the invoice it corrects with customer_invoice_id / supplier_invoice_id; a LINKED note is AUTO-APPLIED at approve, reducing that invoice\'s outstanding balance by up to its outstanding amount. Leave the link out to raise standalone credit. ' +
    'An identical open draft (same counterparty, linked invoice, date and amount) is REFUSED and its id returned — retrying with a new idempotency_key will not create a second one. ' +
    'When it is genuinely a SECOND credit (two returns on one day for one amount), call again with duplicate_of set to the id the refusal named. ' +
    'A customer note linked to an invoice with a VAT type per line must carry that invoice\'s remaining VAT in proportion to the net it credits (not the rate on its subtotal): leave tax_rate and tax_amount out and it defaults to that figure; a tax_rate that misses it is refused, naming it, and approve_credit_note refuses any other tax_amount. ' +
    'A supplier note linked to a bill credits that bill\'s own expense accounts and CC1/CC2/BU pro rata at approve; mirror_bill also takes its VAT from the bill as it stands now (see document_vat_history). ' +
    'Pass external_system + external_ref (e.g. the Sage RTN id) to make the create idempotent: a live note already carrying them FOR THE SAME customer/supplier and linked invoice/bill is returned instead (already_existed: true; payload_differs when its date or amounts differ). A reference already used by a note for another customer/supplier or linked document (a reused reference, a customer merged since, a draft re-linked since) is refused, naming the field and the existing note, and nothing is created.',
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
      gl_account_id: {
        type: 'string',
        description: 'Supplier notes only: the GL account credited when the note is not linked to a bill, or for what the '
          + 'expense lines of the linked bill can no longer take (a linked note reverses the accounts and CC1/CC2/BU of that bill first). '
          + 'Omitted: the default expense account.',
      },
      credit_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      subtotal: { type: 'number', exclusiveMinimum: 0, description: 'NET of VAT' },
      tax_rate: { type: 'number', minimum: 0, maximum: 100, description: 'VAT %; default: the linked document\'s rate, else the standard rate on credit_date (against an invoice with a VAT type per line: accepted only when it gives the required VAT)' },
      tax_amount: { type: 'number', minimum: 0, description: 'The VAT as a figure, instead of tax_rate (sent with tax_rate, the rate must give exactly this figure on the subtotal, or both are refused). Omitted on a note linked to an invoice with a VAT type per line: that invoice\'s remaining VAT in proportion.' },
      reason: { type: 'string' },
      duplicate_of: {
        type: 'string',
        description: 'Only after a refusal: the id of the identical open draft it named, confirming this is a second, separate credit.',
      },
      ...MIRROR_ARG_SCHEMA,
      ...EXTERNAL_REF_CREATE_PROPS,
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
    const xref = parseCreateRef(args);
    if (typeof xref === 'string') return toolError(xref);

    const bad = guardCastableArgs(args, {
      uuid: ['client_id', 'supplier_id', 'customer_invoice_id', 'supplier_invoice_id', 'duplicate_of', 'gl_account_id'],
      date: ['credit_date'],
    });
    if (bad) return bad;

    // The money, before any read or write: the REST route's rule (creditNoteMoneyProblem), so both surfaces refuse
    // the same requests in the same words. JSON numbers only (Number() read "" / [] / false as 0 and true as 1), whole
    // cents, a positive subtotal (a negative one inverts the note's GL at approve), a VAT figure within the subtotal,
    // and a tax_rate beside a tax_amount only when it gives that figure (#1701 round 3).
    const moneyProblem = creditNoteMoneyProblem({ subtotal: args.subtotal, taxRate: args.tax_rate, taxAmount: args.tax_amount }, MCP_MONEY_FIELDS);
    if (moneyProblem) return toolError(moneyProblem);
    const subtotal = args.subtotal as number;
    const taxRate = args.tax_rate == null ? undefined : args.tax_rate as number;
    const taxAmountArg = args.tax_amount == null ? undefined : args.tax_amount as number;

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
    const glAccountId = strArg(args, 'gl_account_id');
    if (type === 'customer' && glAccountId) return toolError('gl_account_id can only be set on a supplier credit note');

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

    // mirror_bill (brief step 5b): the note's VAT from the bill as it stands now, refused — unless
    // acknowledged — when the bill's VAT was already reversed out of proportion. Reads only; before any write.
    const mirrorArgs = readMirrorArgs(args, type, supplierInvoiceId);
    if ('error' in mirrorArgs) return toolError(mirrorArgs.error);
    if (mirrorArgs.mirror && taxAmountArg !== undefined) return toolError('tax_amount cannot be given with mirror_bill: the bill gives the VAT');
    const mirror = mirrorArgs.mirror
      ? await planMirroredSupplierNote(ctx.companyId, supplierInvoiceId!, subtotal, mirrorArgs.ack)
      : null;
    if (mirror && !mirror.ok) return toolError(mirror.reason);
    const mirrored = mirror?.ok ? mirror.plan : null;

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
    // pass the guard.
    //
    // The override is `duplicate_of`, and it must NAME the most recent identical
    // draft — not a boolean. A boolean could be sent blind on a first call, and
    // then every fresh-key retry mints another note. Naming the MOST RECENT one
    // (the lookup orders by created_at) also consumes the override: once the
    // second note exists, a retry still naming the first is refused and told
    // about the second.
    const duplicateOf = strArg(args, 'duplicate_of');
    // The rate the service computes a note with no rate and no figure at (storedCreditNoteRate: the linked document's
    // header rate, else the standard rate on the note's date): a header read, independent of any approval, made only
    // when a total is compared at it (the replay's or the duplicate check's), and at most once.
    let storedRate: Promise<number> | null = null;
    const rateForTotal = (): Promise<number> => taxRate !== undefined ? Promise.resolve(taxRate)
      : (storedRate ??= storedCreditNoteRate(ctx.companyId, { customerInvoiceId, supplierInvoiceId, creditDate }, null));
    // A total as createCreditNote stores it (creditNoteVatAndTotal, exact cents), so a cent-edge note is neither
    // reported as differing on replay nor missed by the duplicate check.
    const totalOf = async (figure: number | undefined): Promise<number> =>
      creditNoteVatAndTotal(subtotal, figure !== undefined ? 0 : await rateForTotal(), figure).totalAmount;
    // A customer note linked to an invoice with no figure given may be one against a TYPED invoice, whose VAT is the
    // invoice's remaining VAT in proportion: read only AFTER the replay, so a replay (by external_ref, after the note was
    // approved) returns the note instead of recomputing a figure its own approval moved. A replay always compares the
    // date and the subtotal (VAT-independent); the total only where the VAT is known without that read (a figure, a rate,
    // mirror_bill, an unlinked or supplier note), so a linked customer note with no figure or rate compares no total.
    const typedCandidate = type === 'customer' && !mirrored && !!customerInvoiceId && taxAmountArg === undefined;
    // Before the duplicate-draft check: re-sending the same source note returns it, rather than a refusal.
    const replay = await createReplayOrLock(ctx, 'credit_note', xref, {
      creditNoteType: type as (typeof TYPES)[number],
      expect: {
        date: creditDate,
        subtotal,
        totalAmount: typedCandidate && taxRate === undefined ? null : await totalOf(mirrored?.taxAmount ?? taxAmountArg),
        // The same note only for the same party and linked document (round 9): a reused reference is refused.
        identity: type === 'customer'
          ? { client_id: clientId ?? null, customer_invoice_id: customerInvoiceId ?? null }
          : { supplier_id: supplierId ?? null, supplier_invoice_id: supplierInvoiceId ?? null },
      },
    });
    if (replay) return replay;
    // The required VAT against a typed invoice (reads only); a tax_rate missing it is refused here, a registered refusal, pre-write.
    const typed = typedCandidate ? await typedCreditNoteVat(ctx.companyId, { type: 'customer', customerInvoiceId, subtotal, taxRate }) : null;
    const figure = typed?.taxAmount ?? taxAmountArg;
    const total = await totalOf(mirrored?.taxAmount ?? figure);

    const duplicate = await findOpenDuplicateDraft(
      ctx.companyId,
      {
        type: type as (typeof TYPES)[number],
        clientId, supplierId, customerInvoiceId, supplierInvoiceId,
        creditDate,
      },
      total,
    );
    if (duplicateOf && !duplicate) {
      // The named draft is no longer an open draft — most likely approved or
      // cancelled since the refusal. The dedupe only sees drafts, so a note
      // created now would sit beside an APPROVED identical one unguarded.
      return toolError(
        `duplicate_of names ${duplicateOf}, which is no longer an identical open draft — it has probably `
        + 'been approved or cancelled since. Check it with get_credit_note first: if it was approved, '
        + 'creating another note now would credit the same amount twice.',
      );
    }
    if (duplicate && duplicate !== duplicateOf) {
      return toolError(
        `An identical draft credit note already exists (id ${duplicate}) for the same counterparty, `
        + 'linked invoice, date and amount. If this is a retry, approve that one with approve_credit_note. '
        + `If it is genuinely a second, separate credit, call again with duplicate_of: "${duplicate}".`,
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
        taxRate: mirrored ? mirrored.taxRate : typed?.taxRate ?? taxRate,
        ...(mirrored ? { taxAmount: mirrored.taxAmount, vatBasis: mirrored.basis } : figure !== undefined ? { taxAmount: figure } : {}),
        ...(mirrored?.basis === 'mirror_bill_ack' ? { vatAckMatches: mirrored.ackMatches } : {}),
        glAccountId,
      },
      ctx.userId,
      // A draft note posts no journal, so the document row is the only place
      // the actor can be recorded until approval (migration 531).
      mcpPostingOpts(ctx, 'create_credit_note'),
    );
    await stampCreated(ctx, 'credit_note', note.id, xref);

    return ok({
      id: note.id,
      credit_note_number: note.creditNoteNumber,
      type: note.type,
      status: note.status,
      subtotal: note.subtotal,
      tax_rate: note.taxRate,
      tax_amount: note.taxAmount,
      total_amount: note.totalAmount,
      ...(xref ? { external_system: xref.system, external_ref: xref.ref } : {}),
      ...(mirrored ? { mirror: mirrorReply(mirrored) } : {}),
    });
  },
};

