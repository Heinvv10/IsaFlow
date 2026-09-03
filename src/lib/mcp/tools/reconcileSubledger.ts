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
 *  - It reports EVERY candidate control account, never one. There is no
 *    canonical AR/AP control account in this schema; thirteen accounts carry
 *    subtype 'receivable' and one carries NULL, and on Brightsphere a R10,000
 *    receipt went to the NULL one while thirty-six others went elsewhere.
 *    Picking one would hide that R10,000 behind a tidier-looking reconciliation.
 *
 *  - It finds cash on the control account with NO payment document behind it.
 *    `allocateTransaction` skips its payment INSERT when it cannot resolve a
 *    uuid-shaped user, so that cash is invisible to every tool that reads
 *    payment rows, `list_unapplied_receipts` included.
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
    'LIMITS. There is no canonical control account in this database, so EVERY candidate is returned in controlAccounts with how it was found ("subtype" = typed for the role, "posting" = subledger documents actually posted to it) and controlAccountAmbiguous is set when more than one exists; the balance is their sum. Deactivated accounts are included — is_active is a picker flag and says nothing about whether an account holds money. ' +
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
      // Rows here are produced BY the reconciler; nothing is filtered out of a
      // wider candidate set, so the universe is exactly what was accounted for.
      universeTotal: rowsTotal + rec.excludedRows.length,
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
      // Named, but deliberately UNOWNED in the figure registry: registering an
      // owner would encode an arbitrary choice of control account as truth and
      // destroy the only thing that can detect the break (FINDINGS C1).
      settlementFlagged: rec.settlementFlagged,
      controlFigureBasis: subledger === 'ap' ? 'ap.control.v1' : 'ar.control.v1',
    });
  },
};
