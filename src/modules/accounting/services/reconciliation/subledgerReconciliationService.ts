/**
 * Subledger ↔ control-account reconciliation, DECOMPOSED.
 *
 * The requirement: itemised reconciling items with document ids, not a gap. A
 * report that says "the difference is R2,691,024" leaves a reader exactly where
 * they started; one that says "R2,681,024 of receipts against 37 payment
 * documents, and R10,000 posted by journal JE-2026-00009 with no payment
 * document at all" ends the investigation.
 *
 * TWO BRIDGES, deliberately kept apart. Re-deriving Brightsphere showed the
 * specification had merged them, which is why its R1,429,774 reconciles to
 * nothing exactly:
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
 * `agedTotal` is READ FROM the aged report, never recomputed here. The second
 * identity is what caught `unageable_document` describing a defect #303 had
 * already fixed, worth R12,730,757.43 of Velocity AR — with the aged total
 * recomputed from this service's own snapshot, both sides moved together and
 * nothing could go red.
 *
 * POINT IN TIME. `as_at` moves BOTH sides: the subledger readers use the same
 * settlement rewind as the aging reports (`services/shared/agingRewind.ts`) and
 * the control balance stops at `entry_date <= as_at`. When only the control
 * side moved, a past-date call closed its arithmetic against today's subledger
 * — R81,996,370.82 of Velocity AR at 2025-12-31, absorbed by one
 * `document_after_as_at` item that has since been removed along with the
 * `afterAsAt` set it was built from.
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
import { getUnappliedControlCash } from './unappliedCashService';
import { getUnpostedSubledgerDocuments } from './unpostedDocumentService';
import { getAgedReportTotal } from './agedReportTotal';
import { getSettlementFlagged, type SettlementFlagged } from './settlementFlagService';
import {
  buildAgedBridgeItems,
  buildControlBridgeItems,
  unexplainedItem,
} from './reconcilingItemBuilders';
export type { ReconcilingBridge, ReconcilingItem } from './reconcilingItemTypes';
import { round2, laterOf } from './reconciliationMath';

import type { ReconcilingItem } from './reconcilingItemTypes';

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
  /** True when more than one account could be "the" control account. */
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
    // node-postgres and removed in pg@9 — it printed a DeprecationWarning on
    // the first production run of this service. Four readers, each issuing
    // several statements of its own, is not the place to rely on the driver's
    // internal queue.
    const controlAccounts = await getControlAccountBalances(companyId, role, asAtDate);
    const snapshot = await readSubledger(companyId, role, asAtDate);
    const agedTotal = await getAgedReportTotal(companyId, role, asAtDate);
    const settlementFlagged = await getSettlementFlagged(companyId, role, asAtDate);

    const excludedRows: SubledgerReconciliation['excludedRows'] = [];
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
        postedThrough: null,
      };
    }

    const cash =
      controlAccounts.length === 0
        ? { withPaymentRecord: [], appliedRecords: [], withoutPaymentRecord: [], total: 0, postedThrough: null }
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

    const items = [
      ...buildAgedBridgeItems({ snapshot, agedTotal }),
      ...buildControlBridgeItems({ snapshot, cash, unposted }),
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
      postedThrough: laterOf(snapshot.postedThrough, cash.postedThrough),
    };
  } catch (err) {
    log.error('Failed to reconcile subledger', { role, error: err }, 'accounting');
    throw err;
  }
}
