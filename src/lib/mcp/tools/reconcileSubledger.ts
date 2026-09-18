/**
 * `reconcile_subledger` — the endpoint this programme exists for.
 *
 * It does not report a gap. It DECOMPOSES the gap into itemised reconciling
 * items carrying the ids of the documents behind them, so a reader finishes the
 * call knowing where the money is rather than that some is missing.
 *
 * Two things it does that a naive version would not, both learned from these
 * books (docs/mcp/FINDINGS.md):
 *
 * A RESIDUAL OF ZERO IS NECESSARY AND NOT SUFFICIENT, and this endpoint has
 * already proved it. Before the control-account direction rule existed,
 * `unexplainedDifference` was 0.00 on every production company AND the AP
 * control balance wrongly included `SYS-9 VAT Payable`: the account contributed
 * -R4,917,814.24 and a `document_not_on_control_account` item of exactly
 * +R4,917,814.24 across the same 356 documents cancelled it. Every number was
 * internally consistent, the identity closed, and the answer was wrong.
 *
 * An identity that always closes cannot detect its own defects, and the more
 * reliably it closes the more it invites being trusted without inspection. The
 * tool description says so in the response's own words, because a reader never
 * sees this file.
 *
 *  - It reports EVERY account TYPED for the role, never one, because there is
 *    no canonical AR/AP control account in this schema — thirteen accounts
 *    carry subtype 'receivable'. It no longer adopts accounts by where
 *    documents posted: `settle_by_contra` reaches a loan account through a
 *    `supplier_payments` row, so that arm made loan accounts into AP control
 *    accounts and moved R453m of one production reconciliation. Those accounts
 *    are reported as `postings_on_non_control_accounts` warnings instead.
 *
 *  - It finds cash on the control account with NO payment document behind it:
 *    a hand-written journal, a receipt whose INSERT `allocateTransaction`
 *    skipped because no uuid-shaped user resolved, or any supplier payment
 *    posted before migration 614, when that path created no document at all.
 *    That cash is invisible to every tool that reads payment rows —
 *    `list_unapplied_receipts` and `list_unapplied_payments` included.
 *
 *  - It answers as at a DATE. Both sides move together: the subledger is
 *    reconstructed by the same settlement rewind the aging reports use
 *    (`services/shared/agingRewind.ts`), and `agedTotal` is read from those
 *    reports rather than recomputed. When only the control account moved, a
 *    past-date reconciliation closed its arithmetic against today's subledger —
 *    R81,996,370.82 of Velocity AR at 2025-12-31, absorbed by a single item.
 */
import type { McpTool } from '../types';
import { fmtDate } from '@/lib/fmtDate';
import {
  reconcileSubledger,
  type ReconcilingItem,
} from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import {
  SUBLEDGER_ROLES,
  type SubledgerRole,
} from '@/modules/accounting/services/gl/controlAccountService';
import {
  buildEnvelope,
  decodeCursor,
  encodeCursor,
  figureBasis,
  isDetailLevel,
  type DetailLevel,
} from '@/lib/mcp/contracts';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/** A read that consumed no ledger row has no `posted_through`; the epoch says so
 *  without pretending the figure is as fresh as the clock. */
const NO_LEDGER_READ = '1970-01-01T00:00:00.000Z';

/** One document behind one reconciling item — the `detail: full` row. */
interface DocumentRow {
  bridge: string;
  type: string;
  documentId: string;
  documentNumber: string | null;
}

function flattenDocuments(items: readonly ReconcilingItem[]): DocumentRow[] {
  const rows: DocumentRow[] = [];
  for (const item of items) {
    item.documentIds.forEach((id, index) => {
      rows.push({
        bridge: item.bridge,
        type: item.type,
        documentId: id,
        // documentNumbers is filtered of blanks, so it can be shorter than
        // documentIds. Index into it defensively rather than mis-pair a number
        // with someone else's document.
        documentNumber:
          item.documentNumbers.length === item.documentIds.length
            ? (item.documentNumbers[index] ?? null)
            : null,
      });
    });
  }
  return rows;
}

export const reconcileSubledgerTool: McpTool = {
  name: 'reconcile_subledger',
  description:
    'Reconciles a subledger to its general-ledger control account as at a date, and DECOMPOSES the difference into itemised reconciling items with the ids of the documents behind each one. ' +
    'Use it to answer "why does the AR control account disagree with what customers owe us", not merely "by how much". ' +
    'Returns: subledgerTotal (every open document, including ones that cannot be aged), agedTotal (what aged_debtors/aged_creditors would show), controlAccountBalance, difference, and reconcilingItems. ' +
    'Each item carries a bridge: "aged_to_subledger" items explain why the AGED REPORT total is not the subledger total (open disputes, which aged buckets are net of; unallocated credit notes, which never reach a bucket) and do NOT explain any GL difference; "subledger_to_control" items explain the GL difference itself (unapplied cash, postings no document claims, documents whose value never reached a control account). Those two are separate questions and adding them together produces a number that reconciles to nothing. Each bridge reports its own residual — "unexplained_difference" and "aged_unexplained_difference" — so an incomplete decomposition on either cannot be mistaken for a complete one. ' +
    'controlAccountBalance + the sum of the subledger_to_control items equals subledgerTotal, and agedTotal + the sum of the aged_to_subledger items equals subledgerTotal. ' +
    'POINT IN TIME: as_at moves BOTH sides. The subledger is reconstructed from settlement that can be dated, on the same basis as aged_debtors/aged_creditors — read the limitations on those tools, which apply here unchanged: the reconstruction will not report a settled document as outstanding, but it can UNDERSTATE a past balance where settlement carries no date (bank-match confirmation and the Sage import both write amount_paid with no dated trail). ' +
    'settlementFlagged lists supplier bills whose payment_matched flag says a matching process considered them settled while their balance says nothing was applied — 397 bills worth R16,151,543.00 on one production company. It is an ATTRIBUTION of part of the difference, NOT an extra reconciling item: that cash is already counted once as posting_with_no_document, so its total is deliberately outside reconcilingItems and must not be added to them. ' +
    'WHAT A RESIDUAL OF ZERO DOES AND DOES NOT MEAN. READ THIS BEFORE RELYING ON IT. unexplainedDifference of 0.00 is NECESSARY AND NOT SUFFICIENT: it says the items sum to the difference, NOT that they are the right items. Two errors that cancel satisfy it exactly. That is not hypothetical — this endpoint reported 0.00 on every production company while wrongly counting a VAT account as an AP control account, because a reconciling item of the same amount across the same 356 documents removed it again. A phantom control account paired with a phantom offset closes the arithmetic and reads as clean books. Treat zero as a precondition for trusting the decomposition and then INSPECT THE ITEMS: check that controlAccounts holds only accounts you accept as control accounts, and that each item names documents you can follow. A non-zero residual is a mechanism this endpoint does not know about; a zero one is an invitation to look, not a conclusion. ' +
    'CONTROL ACCOUNTS ARE RESOLVED BY SUBTYPE AND BY NOTHING ELSE. There is no canonical control account in this database and no company-level setting names one, so EVERY account carrying the role\'s subtype (receivable for ar, payable for ap) is returned in controlAccounts and controlAccountAmbiguous is set when more than one does; the balance is their sum. An account is NOT adopted because subledger documents happened to post to it — settle_by_contra posts DR Accounts Payable / CR <loan account> through a supplier payment, and adopting the loan account produced three "AP control accounts", a document_not_on_control_account item of +R453m and an unexplained difference of -R437m, none of it a fact about the books. Accounts a subledger\'s own documents move in the control direction without carrying the subtype are reported in excludedRows as postings_on_non_control_accounts, with the amount, and the documents whose value went there appear as document_not_on_control_account. Deactivated accounts are included — is_active is a picker flag and says nothing about whether an account holds money. ' +
    'INVARIANTS. The response carries an invariants block, each entry {name, holds, detail}, checked rather than assumed and REPORTED rather than thrown — a violation is the most interesting thing this endpoint can say about a set of books, and a 500 would replace it with nothing. control_plus_items_equals_subledger: controlAccountBalance plus the subledger_to_control items reaches subledgerTotal. item_within_cited_gross: no item claims more than the documents it names are worth, which is what catches an item summed off the wrong column. unexplained_is_the_residual: unexplainedDifference is exactly difference minus the NAMED items, never clamped, floored or plugged. Check holds on all three before reading any figure. ' +
    'UNAPPLIED CASH HAS ONE DEFINITION, shared with list_unapplied_receipts and list_unapplied_payments: a payment\'s total_amount less its allocations, capped, above a cent. The unapplied_receipt item\'s AMOUNT is that payment\'s movement ON THE CONTROL ACCOUNT, because that is what it can explain of the difference, and the item also carries the document figure the listing tools report. Where cash never reached a control account the two differ, and the gap is reported in excludedRows as unapplied_cash_off_control_account rather than folded into an item — on isaflow_dev one company has 130 receipts worth R7.5m in that state against a control balance of -R329,700. ' +
    'posting_with_no_document IS MOSTLY ONE CAUSE CLASS, and it has a remedy: an ALLOCATION JOURNAL WITH NO PAYMENT DOCUMENT. Allocating a bank line posts the control-account journal and, on some paths, creates no supplier_payments or customer_payments row at all — on a production copy 39 journals worth R124,704.80 were in that state, every one of them stamped mcp:bulk_allocate_bank_transactions. Nothing that reads payment rows can see or clear them, so the fix is to create the missing payment document and apply it; list_unapplied_payments and list_unapplied_receipts are blind to them by construction. Reversal journals are NOT in this item: a cancelled payment or credit note nets against its own reversal and both are dropped. '
    + 'unapplied_credit_note is approved credit no document has consumed. The AP subledger carries no credit notes at all, so supplier credit used to fall into the residual with no name on it; approved credit the AR subledger already counts is deliberately not repeated. ' +
    'Only "ar" and "ap" have a document subledger to compare against; "bank", "vat", "payroll" and "inventory" return the GL control accounts with subledgerTotal null and subledgerUnavailable explaining why, rather than a difference of zero that means nothing. ' +
    'detail: "summary" returns totals only, "standard" (default) returns one row per reconciling item, "full" returns one row per underlying document and is paginated — call again with cursor until next_cursor is null. Follow a documentId with get_invoice, list_invoices or list_journals depending on the item type.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      subledger: {
        type: 'string',
        enum: [...SUBLEDGER_ROLES],
        description: 'Which subledger to reconcile. Required.',
      },
      as_at: {
        type: 'string',
        format: 'date',
        description: 'Reporting date, YYYY-MM-DD. Defaults to today.',
      },
      detail: {
        type: 'string',
        enum: ['summary', 'standard', 'full'],
        description: 'summary = totals only; standard (default) = reconciling items; full = underlying documents.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'detail=full only. Default 200.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    required: ['subledger'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const subledger = strArg(args, 'subledger');
    if (!subledger || !(SUBLEDGER_ROLES as readonly string[]).includes(subledger)) {
      // Naming the valid values beats filtering to nothing: an empty
      // reconciliation reads to an agent as "these books agree".
      return toolError(`invalid subledger — expected one of: ${SUBLEDGER_ROLES.join(', ')}`);
    }
    const bad = guardCastableArgs(args, { date: ['as_at'] });
    if (bad) return bad;

    const rawDetail = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';
    const asAt = strArg(args, 'as_at') ?? fmtDate(new Date());

    // Decode BEFORE the query: a malformed cursor is a caller error, and a read
    // tool runs with no savepoint, so nothing may throw after the query has run.
    const rawCursor = strArg(args, 'cursor');
    let after: string | null = null;
    if (rawCursor !== undefined) {
      const decoded = decodeCursor(rawCursor, 1);
      if (!decoded) return toolError('invalid cursor');
      after = decoded.parts[0]!;
    }

    // companyId from ctx ONLY.
    const rec = await reconcileSubledger(ctx.companyId, subledger as SubledgerRole, asAt);

    const isFull = detail === 'full';
    const allRows: Array<ReconcilingItem | DocumentRow> = isFull
      ? flattenDocuments(rec.reconcilingItems)
      : [...rec.reconcilingItems];
    const rowsTotal = allRows.length;

    let page = allRows;
    let nextCursor: string | null = null;
    if (isFull) {
      const docs = allRows as DocumentRow[];
      const start = after === null ? 0 : docs.findIndex((d) => d.documentId === after) + 1;
      const limit = clampLimit(args, 200, 500);
      page = docs.slice(start, start + limit);
      const last = page[page.length - 1] as DocumentRow | undefined;
      if (last && start + limit < docs.length) {
        nextCursor = encodeCursor({ parts: [last.documentId] });
      }
    }

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : page,
      rowsTotal,
      detail,
      as_at: asAt,
      posted_through: rec.postedThrough ?? NO_LEDGER_READ,
      next_cursor: nextCursor,
      excludedRows: rec.excludedRows,
      // universeTotal is DELIBERATELY ABSENT. There is no wider candidate set
      // here: these rows are PRODUCED by the report, not selected out of a
      // pool, so any universe would have to be synthesized from the very
      // numbers the envelope checks against it — `rowsTotal + excludedRows`.
      // That is the anti-pattern CONTRACTS.md §1 names, and it cannot fail
      // whatever this code did. An absent completeness claim is honest; one
      // that cannot fail is worse than none, because it reads as verification.
      figureBasis: figureBasis(subledger === 'ap' ? 'ap.subledger.v1' : 'ar.subledger.v1'),
    });

    return ok({
      ...envelope,
      subledger: rec.subledger,
      agedTotal: rec.agedTotal,
      subledgerTotal: rec.subledgerTotal,
      subledgerUnavailable: rec.subledgerUnavailable,
      controlAccounts: rec.controlAccounts,
      controlAccountBalance: rec.controlAccountBalance,
      controlAccountAmbiguous: rec.controlAccountAmbiguous,
      difference: rec.difference,
      unexplainedDifference: rec.unexplainedDifference,
      // Checked, not assumed, and reported rather than thrown. See the
      // description and reconciliationInvariants.ts.
      invariants: rec.invariants,
      // Named, but deliberately UNOWNED in the figure registry: registering an
      // owner would encode an arbitrary choice of control account as truth and
      // destroy the only thing that can detect the break (FINDINGS C1).
      settlementFlagged: rec.settlementFlagged,
      controlFigureBasis: subledger === 'ap' ? 'ap.control.v1' : 'ar.control.v1',
    });
  },
};
