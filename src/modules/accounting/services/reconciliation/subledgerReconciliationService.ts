/**
 * Subledger ↔ control-account reconciliation, DECOMPOSED.
 *
 * The requirement: itemised reconciling items with document ids, not a gap. A
 * report that says "the difference is R2,691,024" leaves a reader where they
 * started; one that names the 37 payment documents and the journal behind the
 * rest ends the investigation.
 *
 * TWO BRIDGES, deliberately kept apart — merging them is why Brightsphere's
 * R1,429,774 reconciles to nothing exactly:
 *
 *   aged_to_subledger    why the AGED REPORT'S total is not the subledger's —
 *                        open disputes, which its bucket totals are net of, and
 *                        unallocated credit notes, which never reach a bucket.
 *                        These do NOT explain any GL difference: those
 *                        documents' own journals are in the control account.
 *   subledger_to_control what the SUBLEDGER and the GL disagree about —
 *                        unapplied cash, postings no document claims,
 *                        documents whose value never reached control. This is
 *                        the reconciliation proper.
 *
 * TWO IDENTITIES, one per bridge, each with its own residual emitted AS AN ITEM
 * whenever it is non-zero — so a decomposition that gave up says so in the same
 * list a complete one uses:
 *
 *   controlAccountBalance + Σ(subledger_to_control items) = subledgerTotal
 *   agedTotal             + Σ(aged_to_subledger items)    = subledgerTotal
 *
 * Both are ASSERTED rather than assumed, with the checks that cannot close by
 * construction, in `reconciliationInvariants.ts`.
 *
 * `agedTotal` is READ FROM the aged report, never recomputed here: recomputing
 * it from this service's own snapshot moved both sides together and nothing
 * could go red.
 *
 * POINT IN TIME. `as_at` moves BOTH sides: the subledger readers use the same
 * settlement rewind as the aging reports (`services/shared/agingRewind.ts`) and
 * the control balance stops at `entry_date <= as_at`.
 */

import { log } from '@/lib/logger';
import {
  getControlAccountBalances,
  type ControlAccountBalance,
  type SubledgerRole,
} from '../gl/controlAccountService';
import { getARSubledger } from '../ar/arSubledgerService';
import { getAPSubledger } from '../ap/apSubledgerService';
import type { SubledgerDocument, SubledgerSnapshot } from '../ar/subledgerTypes';
import { getNonControlPostingAccounts } from '../gl/nonControlPostingAccounts';
import { getUnappliedControlCash } from './unappliedCashService';
import { getUnappliedCreditNotes } from './unappliedCreditNoteService';
import { getUnpostedSubledgerDocuments } from './unpostedDocumentService';
import { getAgedReportTotal } from './agedReportTotal';
import { getSettlementFlagged, type SettlementFlagged } from './settlementFlagService';
import { getLedgerPostedThrough } from '../reports/postedThroughService';
import {
  buildAgedBridgeItems,
  buildControlBridgeItems,
  unexplainedItem,
} from './reconcilingItemBuilders';
import { checkInvariants } from './reconciliationInvariants';
import { nonControlPostingWarnings, offControlCashWarnings } from './reconcilingWarnings';
export type {
  ReconciliationInvariant,
  ReconcilingBridge,
  ReconcilingItem,
} from './reconcilingItemTypes';
import { round2, laterOf } from './reconciliationMath';

import type { ReconciliationInvariant, ReconcilingItem } from './reconcilingItemTypes';

export interface SubledgerReconciliation {
  subledger: SubledgerRole;
  as_at: string;
  /**
   * What `aged_debtors` / `aged_creditors` DO total, read from those reports
   * rather than recomputed. Null for a role with no aged report.
   */
  agedTotal: number | null;
  /** Every open document, including the ones that cannot be aged. */
  subledgerTotal: number | null;
  /** Why the subledger side is absent, when it is. */
  subledgerUnavailable: { reason: string; detail: string } | null;
  /** EVERY candidate control account. There is no canonical one — FINDINGS C1. */
  controlAccounts: ControlAccountBalance[];
  /** Sum across all of them. Null when none exists — never a fabricated zero. */
  controlAccountBalance: number | null;
  /**
   * True when more than one account CARRIES THE CONTROL SUBTYPE. It used to be
   * true whenever more than one account a subledger document had posted to was
   * found, which made a `settle_by_contra` loan account into a third "AP
   * control account" on production.
   */
  controlAccountAmbiguous: boolean;
  /** subledgerTotal − controlAccountBalance. Null when either side is absent. */
  difference: number | null;
  reconcilingItems: ReconcilingItem[];
  /** difference − Σ(subledger_to_control items). Zero on a full decomposition. */
  unexplainedDifference: number | null;
  excludedRows: Array<{ id: string; reason: string; detail?: string; amount?: number }>;
  /**
   * Bills a matching process already believed settled, still open. NOT a
   * reconciling item and deliberately outside `reconcilingItems`: the cash is
   * already counted once as `posting_with_no_document`, so counting it again
   * would drive the residual to minus this amount. It attributes part of an
   * existing difference rather than adding to it — see settlementFlagService.
   */
  settlementFlagged: SettlementFlagged;
  /**
   * What this reconciliation asserts about its own output, and whether it
   * holds. Reported rather than thrown: a violation is the most interesting
   * thing the endpoint can say about a set of books, and a 500 would replace it
   * with nothing. See reconciliationInvariants.ts.
   */
  invariants: ReconciliationInvariant[];
  postedThrough: string | null;
}

/** The subledger reader for a role, or null when the role has no document source. */
async function readSubledger(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
): Promise<(SubledgerSnapshot & { disputes?: ReadonlyMap<string, number> }) | null> {
  if (role === 'ar') return getARSubledger(companyId, asAtDate);
  if (role === 'ap') return getAPSubledger(companyId, asAtDate);
  return null;
}

const NO_SOURCE_DETAIL: Record<string, string> = {
  bank: 'Bank reconciliation compares a statement feed to the GL, not a document subledger. Use the banking tools, which own the cash figure and its statement-coverage gap.',
  vat: 'VAT is posted from the transactions of other subledgers and has no document subledger of its own. Use the VAT return tools for the return-to-ledger comparison.',
  payroll: 'No payroll subledger is populated on this company. The GL side is reported so the control accounts and their balances are still visible.',
  inventory: 'No account in this database carries an inventory subtype and no stock subledger is populated. The GL side is reported as-is.',
};

/**
 * @param asAtDate 'YYYY-MM-DD'. Strings throughout — no Date arithmetic anywhere
 *   on this path; SAST is UTC+2 and this repo has a live UTC-rollback defect class.
 */
export async function reconcileSubledger(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
): Promise<SubledgerReconciliation> {
  try {
    // SEQUENTIAL, not Promise.all. Every read here runs on the ONE pg client
    // the request's transaction holds (via the ALS context), and issuing
    // queries on a client that is already executing one is deprecated in
    // node-postgres and removed in pg@9. Several readers, each issuing several
    // statements, is not the place to rely on the driver's internal queue.
    const controlAccounts = await getControlAccountBalances(companyId, role, asAtDate);
    const snapshot = await readSubledger(companyId, role, asAtDate);
    const agedTotal = await getAgedReportTotal(companyId, role, asAtDate);
    const settlementFlagged = await getSettlementFlagged(companyId, role, asAtDate);
    // The LEDGER side of posted_through. Half this endpoint's answer is
    // `controlAccountBalance`, read from the journals, and the subledger's own
    // MAX(created_at) says nothing about them: a journal posted to a control
    // account after the newest document, dated on or before as_at, moves the
    // difference while leaving posted_through untouched. The contract's
    // invariant — same as_at plus same posted_through reproduces the same
    // figures — would then be false in the one endpoint where the control side
    // IS the question. Same function every other report uses; one definition of
    // how fresh a figure is.
    const ledgerPostedThrough = await getLedgerPostedThrough(companyId, asAtDate);
    // Accounts this subledger's own documents move in the control direction
    // that are NOT typed for the role. They used to be ADOPTED as control
    // accounts; they are now reported, because an untyped account carrying
    // payable-direction movement from supplier documents is either a mistyped
    // chart or a settlement route nobody has reviewed.
    const nonControl = await getNonControlPostingAccounts(companyId, role, asAtDate);

    const excludedRows: SubledgerReconciliation['excludedRows'] = [
      ...nonControlPostingWarnings(role, nonControl),
    ];
    // A control balance of zero and NO control account are different facts.
    // Reporting the first when the second is true fabricates a difference.
    const controlAccountBalance =
      controlAccounts.length === 0 ? null : round2(controlAccounts.reduce((s, a) => s + a.balance, 0));
    if (controlAccounts.length === 0) {
      excludedRows.push({
        id: `${role}-control`,
        reason: 'no_control_account',
        detail: `No GL account is typed for the ${role.toUpperCase()} subledger, and no ${role.toUpperCase()} document has posted its control leg to one. There is nothing to reconcile against.`,
      });
    }

    const base = {
      subledger: role,
      as_at: asAtDate,
      controlAccounts,
      controlAccountBalance,
      controlAccountAmbiguous: controlAccounts.length > 1,
      excludedRows,
      settlementFlagged,
    };

    if (!snapshot) {
      return {
        ...base,
        agedTotal: null,
        subledgerTotal: null,
        subledgerUnavailable: {
          reason: 'no_subledger_source',
          detail: NO_SOURCE_DETAIL[role] ?? 'This subledger has no document-level source.',
        },
        difference: null,
        reconcilingItems: [],
        unexplainedDifference: null,
        invariants: checkInvariants({
          subledgerTotal: null,
          controlAccountBalance,
          difference: null,
          unexplained: null,
          items: [],
        }),
        // The GL side is still reported for these roles, so its freshness is
        // still a claim this response makes.
        postedThrough: ledgerPostedThrough,
      };
    }

    const cash =
      controlAccounts.length === 0
        ? {
            withPaymentRecord: [], appliedRecords: [], withoutPaymentRecord: [],
            offControl: [], total: 0, postedThrough: null,
          }
        : await getUnappliedControlCash(
            companyId,
            role,
            asAtDate,
            controlAccounts.map((a) => a.accountId),
          );

    const unposted =
      controlAccounts.length === 0
        ? []
        : await getUnpostedSubledgerDocuments(
            companyId,
            role,
            asAtDate,
            controlAccounts.map((a) => a.accountId),
          );

    excludedRows.push(...offControlCashWarnings(cash.offControl));

    // Approved credit the subledger does not already carry. AR passes the ids
    // its snapshot holds so they are not counted twice; AP has no credit-note
    // leg at all, which is exactly why this item exists.
    const creditNotes =
      role === 'ar' || role === 'ap'
        ? await getUnappliedCreditNotes(
            companyId,
            role,
            asAtDate,
            snapshot.creditNotes.map((c) => c.id),
          )
        : [];

    const items = [
      ...buildAgedBridgeItems({ snapshot, agedTotal }),
      ...buildControlBridgeItems({ snapshot, cash, unposted, creditNotes }),
    ];

    const difference =
      controlAccountBalance === null ? null : round2(snapshot.subledgerTotal - controlAccountBalance);
    const explained = round2(
      items.filter((i) => i.bridge === 'subledger_to_control').reduce((s, i) => s + i.amount, 0),
    );
    const unexplained = difference === null ? null : round2(difference - explained);

    if (unexplained !== null && unexplained !== 0) {
      items.push(unexplainedItem(unexplained));
    }

    return {
      ...base,
      agedTotal,
      subledgerTotal: snapshot.subledgerTotal,
      subledgerUnavailable: null,
      difference,
      reconcilingItems: items,
      unexplainedDifference: unexplained,
      invariants: checkInvariants({
        subledgerTotal: snapshot.subledgerTotal,
        controlAccountBalance,
        difference,
        unexplained,
        items,
      }),
      postedThrough: laterOf(
        laterOf(snapshot.postedThrough, cash.postedThrough),
        ledgerPostedThrough,
      ),
    };
  } catch (err) {
    log.error('Failed to reconcile subledger', { role, error: err }, 'accounting');
    throw err;
  }
}
