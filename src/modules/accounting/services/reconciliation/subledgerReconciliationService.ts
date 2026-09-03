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
 *   aged_to_subledger    what the AGED REPORT drops but the subledger holds —
 *                        a null due date, an amount under dispute. These do NOT
 *                        explain any GL difference: the invoice's own journal
 *                        is in the control account.
 *   subledger_to_control what the SUBLEDGER and the GL disagree about —
 *                        unapplied cash, documents dated after the reporting
 *                        date. This is the reconciliation proper.
 *
 * The identity every caller can check:
 *   controlAccountBalance + Σ(subledger_to_control items) = subledgerTotal
 * `unexplainedDifference` is the residual and is emitted AS AN ITEM whenever it
 * is non-zero, so a decomposition that gave up says so in the same list a
 * complete one uses.
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
import {
  buildReconcilingItems,
  sumBalances,
  unexplainedItem,
} from './reconcilingItemBuilders';
export type { ReconcilingBridge, ReconcilingItem } from './reconcilingItemTypes';
import { round2, laterOf } from './reconciliationMath';

import type { ReconcilingItem } from './reconcilingItemTypes';

export interface SubledgerReconciliation {
  subledger: SubledgerRole;
  as_at: string;
  /** What `aged_debtors` / `aged_creditors` would total. Null with no subledger. */
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
    const [controlAccounts, snapshot] = await Promise.all([
      getControlAccountBalances(companyId, role, asAtDate),
      readSubledger(companyId, role, asAtDate),
    ]);

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
        ? { withPaymentRecord: [], withoutPaymentRecord: [], total: 0, postedThrough: null }
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

    const items = buildReconcilingItems({ snapshot, cash, unposted, asAtDate });

    const difference =
      controlAccountBalance === null ? null : round2(snapshot.subledgerTotal - controlAccountBalance);
    const explained = round2(
      items.filter((i) => i.bridge === 'subledger_to_control').reduce((s, i) => s + i.amount, 0),
    );
    const unexplained = difference === null ? null : round2(difference - explained);

    if (unexplained !== null && unexplained !== 0) {
      items.push(unexplainedItem(unexplained));
    }

    const disputes = snapshot.disputes;
    const agedTotal = round2(
      sumBalances(snapshot.ageable) +
        sumBalances(snapshot.creditNotes) -
        (disputes
          ? snapshot.ageable.reduce((s, d) => s + Math.min(disputes.get(d.id) ?? 0, d.balance), 0)
          : 0),
    );

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
