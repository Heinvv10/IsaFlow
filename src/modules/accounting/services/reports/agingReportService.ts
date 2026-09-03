/**
 * Aged debtors / aged creditors, with the completeness the old report lacked.
 *
 * `aged_debtors` returned exactly ten customer rows totalling R63.1m with no
 * total, no row count and no truncation flag, and it silently dropped every
 * document with a null due date — R1,058,000 of a reconciling difference was
 * one such row. Ten is a suspicious number to a human and an unremarkable one
 * to an agent.
 *
 * Three things change here and each answers one of those:
 *   - the report carries its own totals and its own universe;
 *   - a document that CANNOT be aged is excluded WITH ITS AMOUNT and its
 *     number, so a reader can tell R1.06m of exclusions from three of them;
 *   - unapplied receipts are reported beside the buckets, because "what we are
 *     owed" computed while R2.69m of receipts sit unapplied on the control
 *     account is the misleading half of the truth.
 *
 * The bucket arithmetic itself is NOT reimplemented: `calculateAgingBuckets` is
 * the same function the UI uses, called with the same rows.
 */

import { log } from '@/lib/logger';
import { calculateAgingBuckets } from '../../utils/aging';
import type { AgingBucket, AgingInvoice } from '../../types/ap.types';
import { getARSubledger } from '../ar/arSubledgerService';
import { getAPSubledger } from '../ap/apSubledgerService';
import type { SubledgerDocument } from '../ar/subledgerTypes';
import { getControlAccountBalances } from '../gl/controlAccountService';
import { getUnappliedControlCash } from '../reconciliation/unappliedCashService';
import { laterOf, round2 } from '../reconciliation/reconciliationMath';

export type AgingSide = 'ar' | 'ap';

export interface AgingExclusion {
  id: string;
  reason: 'null_due_date';
  detail: string;
  amount: number;
  documentNumber: string | null;
  entityName: string;
}

export interface AgingTotals {
  current: number;
  days30: number;
  days60: number;
  days90: number;
  days120Plus: number;
  disputed: number;
  total: number;
}

export interface AgingReport {
  asAt: string;
  buckets: AgingBucket[];
  totals: AgingTotals;
  /** Documents that could not be aged. Never silently dropped. */
  excluded: AgingExclusion[];
  /** Their combined balance — the number that says whether to care. */
  excludedTotal: number;
  /**
   * Classification outcomes across entities: entities with a bucketed balance
   * PLUS excluded documents. This is the universe the envelope checks
   * `rowsTotal + excludedRows.length` against, so it is defined in exactly
   * those terms rather than as a count of something else.
   */
  entityUniverse: number;
  /**
   * Cash on the control account not applied to any document. Reported here
   * because a debtors figure means something different when R2.69m of receipts
   * are sitting unapplied, and a reader should not need a second call to find
   * that out. Zero when no control account could be resolved.
   */
  unappliedReceipts: number;
  /** The full open subledger, including the documents excluded above. */
  subledgerTotal: number;
  postedThrough: string | null;
}

const ZERO: AgingTotals = {
  current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, disputed: 0, total: 0,
};

function toAgingInvoice(d: SubledgerDocument, disputed: number): AgingInvoice {
  return {
    id: d.id,
    entityId: d.entityId,
    entityName: d.entityName,
    // Only ageable documents reach here, so dueDate is non-null by construction.
    dueDate: d.dueDate!,
    totalAmount: d.totalAmount,
    amountPaid: d.amountPaid,
    balance: d.balance,
    disputedAmount: disputed,
  };
}

/**
 * The buckets for a snapshot. Exported so `getARAging` / `getAPAging` — the
 * functions the UI calls — produce their buckets from THIS code rather than
 * from a second copy of the same loop.
 */
export function bucketsForSnapshot(
  snapshot: { ageable: readonly SubledgerDocument[] },
  disputes: ReadonlyMap<string, number>,
  asAtDate: string,
): AgingBucket[] {
  return calculateAgingBuckets(
    snapshot.ageable.map((d) => toAgingInvoice(d, disputes.get(d.id) ?? 0)),
    new Date(asAtDate),
  );
}

function sumBuckets(buckets: readonly AgingBucket[]): AgingTotals {
  return buckets.reduce<AgingTotals>(
    (acc, b) => ({
      current: round2(acc.current + b.current),
      days30: round2(acc.days30 + b.days30),
      days60: round2(acc.days60 + b.days60),
      days90: round2(acc.days90 + b.days90),
      days120Plus: round2(acc.days120Plus + b.days120Plus),
      disputed: round2(acc.disputed + (b.disputed ?? 0)),
      total: round2(acc.total + b.total),
    }),
    { ...ZERO },
  );
}

/**
 * @param asAtDate 'YYYY-MM-DD'. A string throughout — no Date arithmetic on
 *   this path beyond the one `calculateAgingBuckets` already performs on two
 *   dates parsed the same way.
 */
export async function getAgingReport(
  companyId: string,
  side: AgingSide,
  asAtDate: string,
): Promise<AgingReport> {
  try {
    const snapshot =
      side === 'ar'
        ? await getARSubledger(companyId, asAtDate)
        : await getAPSubledger(companyId, asAtDate);
    const disputes =
      'disputes' in snapshot ? (snapshot.disputes as ReadonlyMap<string, number>) : new Map();

    const buckets = bucketsForSnapshot(snapshot, disputes, asAtDate);

    const excluded: AgingExclusion[] = snapshot.unageable.map((d) => ({
      id: d.id,
      reason: 'null_due_date' as const,
      detail: 'No due date, so the document cannot be placed in an aging bucket. It is still owed and is counted in subledgerTotal.',
      amount: round2(d.balance),
      documentNumber: d.documentNumber,
      entityName: d.entityName,
    }));

    // Unapplied cash needs the control accounts. With none resolved there is
    // nothing for cash to be unapplied against, and getUnappliedControlCash
    // short-circuits rather than scanning the whole ledger.
    const controlAccounts = await getControlAccountBalances(companyId, side, asAtDate);
    const cash = await getUnappliedControlCash(
      companyId,
      side,
      asAtDate,
      controlAccounts.map((a) => a.accountId),
    );

    return {
      asAt: asAtDate,
      buckets,
      totals: sumBuckets(buckets),
      excluded,
      excludedTotal: round2(excluded.reduce((s, e) => s + e.amount, 0)),
      entityUniverse: buckets.length + excluded.length,
      unappliedReceipts: cash.total,
      subledgerTotal: snapshot.subledgerTotal,
      postedThrough: laterOf(snapshot.postedThrough, cash.postedThrough),
    };
  } catch (err) {
    log.error('Failed to build the aging report', { side, error: err }, 'accounting');
    throw err;
  }
}
