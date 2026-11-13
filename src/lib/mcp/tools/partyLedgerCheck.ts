/**
 * `party_ledger_check` -- statement vs aged vs GL, per document, for ONE supplier or customer.
 *
 * `reconcile_subledger` answers "why does the AP control account disagree with
 * the creditors" for the whole company, as items. This answers the question an
 * accountant asks next: "this one supplier's statement does not agree with the
 * ledger -- which documents are it?". It joins the statement, the aged view and
 * each document's OWN journal, and flags each document whose views differ, with
 * the difference and a reason class.
 *
 * Nothing is recomputed: the statement balance, the aged balances and the
 * control accounts are the services behind supplier_statement / customer_statement,
 * aged_creditors / aged_debtors and reconcile_subledger (see the service header).
 */
import type { McpTool } from '../types';
import { fmtDate } from '@/lib/fmtDate';
import {
  partyLedgerCheck,
  documentSortKey,
  PartyTooLargeError,
} from '@/modules/accounting/services/reconciliation/partyLedgerCheckService';
import type { PartyDocument, PartyType } from '@/modules/accounting/services/reconciliation/partyLedgerTypes';
import {
  buildEnvelope,
  compareCursorKeys,
  decodeCursor,
  encodeCursor,
  figureBasis,
  isDetailLevel,
  type DetailLevel,
  type ExcludedRow,
} from '@/lib/mcp/contracts';
import { clampLimit, guardCastableArgs, NOT_FOUND, ok, strArg, toolError } from './toolHelpers';

const PARTY_TYPES: readonly PartyType[] = ['supplier', 'customer'];

export const partyLedgerCheckTool: McpTool = {
  name: 'party_ledger_check',
  description:
    'Statement versus general ledger, PER DOCUMENT, for one supplier or customer. For every document the party has dated on or before as_at -- bills/invoices, credit notes, payments/receipts (contras and refunds are payments with a method), and customer write-offs -- it shows three views side by side: the STATEMENT effect (exactly what supplier_statement / customer_statement counts for it), the SUBLEDGER view (total, settled, and for invoices the outstanding aged_creditors / aged_debtors shows, plus the allocation rows behind the settlement), and the GL view (the net of that document\'s OWN journal, including any reversals, on the AP/AR control accounts, resolved by subtype exactly as reconcile_subledger does). A document whose statement effect differs from its GL net is flagged with the difference and a reason class. ' +
    'SIGN: every figure points the way the statement does -- positive means the customer owes us / we owe the supplier. ' +
    'REASON CLASSES (statement_vs_gl): document_not_linked_to_journal (an invoice/bill with no journal link), settlement_with_no_journal (a payment, credit note or write-off that reduces the balance but posted nothing), journal_not_posted (linked journal is draft or missing), journal_dated_after_as_at, reversed_journal_live_document (journal reversed while the document is live), excluded_document_has_live_journal (statement leaves it off, e.g. cancelled, but its journal still stands), posted_to_non_control_account (the value went to accounts not typed as the control account; postedTo names them), journal_amount_differs, write_off_not_on_statement (statements do not list write-offs, so the invoice still shows as owed), unclassified_difference (nothing above explains it). SUBLEDGER-TRAIL classes: amount_paid_differs_from_allocations and applied_differs_from_allocations -- the document says it is settled by an amount its allocation rows do not support (a bank-match confirmation writes amount_paid with no allocation row). ' +
    'TOTALS: statementBalance (the statement service), agedNet (the open documents aged_debtors/aged_creditors list for this party, disputes not taken out), glControlNet (sum of the documents\' own journals on the control accounts), statementMinusGl, classifiedDifference (what the named classes carry), unexplainedResidual (the rest), and agedBridge, which accounts for agedNet minus statementBalance with unapplied cash, unapplied credit and write-offs. ' +
    'READ THIS BEFORE RELYING ON IT. unexplainedResidual of 0.00 is necessary and NOT sufficient: it says every difference has a name, not that the names are right. Check the invariants block (each {name, holds, detail}); a failing one means a statement line has no document row or the two readers disagree about which documents are open. A bare journal names no party, so journals no document claims cannot be attributed to this party: `unattributed` counts them COMPANY-WIDE and they are outside this party\'s totals -- if the party has a gap no document explains, look there (reconcile_subledger itemises them). ' +
    'SHARED JOURNALS. One journal can carry several documents (a split bank allocation naming several contacts; a supplier batch posts one journal for all its members). Journal lines name no party, so a document\'s own leg is counted only when provable: the journal\'s control lines match its documents\' amounts one to one, or the batch total equals the control line. Otherwise the documents get class shared_journal_unattributable, carry no GL view, and are left OUT of statementMinusGl (totals.sharedJournalUnattributable counts them), so the gap is never silently smaller. gl.attribution says which rule applied. ' +
    'COST. Every document of the party is read and compared before detail or limit apply, so summary costs the same as full (a few queries plus one journal-chain walk per document). A party with more than 20,000 documents on or before as_at is refused with the count; use an earlier as_at. ' +
    'detail: "summary" = totals, control accounts, invariants and the party only (small); "standard" (default) = only the FLAGGED documents; "full" = every document, clean ones included. standard and full are paginated: call again with cursor until next_cursor is null. Follow an id with get_invoice, get_supplier_invoice, get_credit_note, list_supplier_payments or list_journals. Read-only; needs read:reports like the statement tools.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      party_type: { type: 'string', enum: [...PARTY_TYPES], description: 'supplier or customer. Required.' },
      party_id: { type: 'string', description: 'Supplier or customer UUID from list_suppliers / list_customers. Required.' },
      as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'], description: 'summary = totals only; standard (default) = flagged documents; full = every document.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'standard/full only. Default 100.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    required: ['party_type', 'party_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const partyType = strArg(args, 'party_type');
    if (!partyType || !(PARTY_TYPES as readonly string[]).includes(partyType)) {
      return toolError(`invalid party_type -- expected one of: ${PARTY_TYPES.join(', ')}`);
    }
    const bad = guardCastableArgs(args, { uuid: ['party_id'], date: ['as_at'] });
    if (bad) return bad;
    const partyId = strArg(args, 'party_id');
    if (!partyId) return toolError('party_id is required');

    const rawDetail = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';
    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());

    // Decode BEFORE the query: a read tool has no savepoint, so nothing may throw after it ran.
    const rawCursor = strArg(args, 'cursor');
    let after: { parts: readonly string[] } | null = null;
    if (rawCursor !== undefined) {
      after = decodeCursor(rawCursor, 3);
      if (!after) return toolError('invalid cursor');
    }

    // companyId from ctx ONLY. A party in another tenant reads exactly like a miss.
    let check;
    try {
      check = await partyLedgerCheck(ctx.companyId, partyType as PartyType, partyId, asAt);
    } catch (err) {
      // Refused before any comparison ran; the message is the count and the way out.
      if (err instanceof PartyTooLargeError) return toolError(err.message);
      throw err;
    }
    if (!check) return toolError(NOT_FOUND);

    const pool: PartyDocument[] = detail === 'full'
      ? check.documents
      : check.documents.filter((d) => d.flags.length > 0);
    const rows = detail === 'summary' ? [] : pool;
    const remaining = after
      ? rows.filter((d) => compareCursorKeys({ parts: documentSortKey(d) }, after!) > 0)
      : rows;
    const limit = clampLimit(args, 100, 500);
    const page = remaining.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = last && remaining.length > limit ? encodeCursor({ parts: documentSortKey(last) }) : null;

    const excludedRows: ExcludedRow[] = check.controlAccounts.length === 0
      ? [{
          id: `${partyType === 'customer' ? 'ar' : 'ap'}-control`,
          reason: 'no_control_account',
          detail: 'No GL account is typed for this subledger, so there is no GL view to compare the statement with; documents carry difference null.',
        }]
      : [];

    const envelope = buildEnvelope({
      rows: page,
      rowsTotal: pool.length,
      detail,
      as_at: asAt,
      posted_through: check.postedThrough,
      next_cursor: nextCursor,
      excludedRows,
      // universeTotal is deliberately absent: standard rows are the flagged subset of the
      // documents (totals.documents.total counts the pool), not a classification of a wider set.
      figureBasis: figureBasis(partyType === 'customer' ? 'ar.subledger.v1' : 'ap.subledger.v1'),
    });

    return ok({
      ...envelope,
      partyType: check.partyType,
      party: check.party,
      controlAccounts: check.controlAccounts,
      totals: check.totals,
      invariants: check.invariants,
      unattributed: check.unattributed,
    });
  },
};
