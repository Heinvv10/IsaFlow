/**
 * Cash sitting on a control account that has not been applied to a document.
 *
 * This is the single biggest reconciling item in these books — R2,691,024 on
 * Brightsphere, every cent of it — and it arrives by TWO mechanisms that need
 * two different queries. A reconciler that runs only the first reports a set of
 * books far cleaner than they are:
 *
 *   1. `allocateTransaction(allocType='customer')` posts DR Bank / CR AR and
 *      writes no allocation rows and no `amount_paid` (FINDINGS B2). A
 *      `customer_payments` row exists with nothing allocated against it.
 *
 *   2. Control-account movement that NO subledger document references at all.
 *      `allocateTransaction` SKIPS its payment INSERT when it cannot resolve a
 *      uuid-shaped user (FINDINGS B24), so cash reaches the control account by
 *      plain journal with no payment row behind it — nothing else in this
 *      programme can see that state, because every other tool reads payment
 *      rows and there is no row to read. The same query also catches the
 *      mirror case, an invoice journal whose document lost its
 *      `gl_journal_entry_id`, which is why the movement is taken SIGNED rather
 *      than filtered to the cash direction: the two partitions (documents that
 *      claim a journal, journals no document claims) have to cover the control
 *      account exactly once each or the decomposition cannot close.
 *
 * The two are reported separately because the remedy differs: the first can be
 * applied through the existing cash-application path, the second has no
 * document to apply and needs one created first.
 *
 * WHICH PAYMENTS ARE UNAPPLIED IS NOT DECIDED HERE. It is
 * `shared/unappliedPaymentBasis.ts`, the same function `list_unapplied_receipts`
 * and `list_unapplied_payments` read: one status filter, one threshold, one
 * basis. This file used to decide it again and differently, so the reconciler
 * and the listing tools answered the same question with different numbers.
 *
 * WHAT IS STILL MEASURED HERE, AND WHY IT MUST BE. A reconciling item's amount
 * is the part of `subledgerTotal − controlAccountBalance` it explains, so it
 * has to be the payment's movement ON THE CONTROL ACCOUNT, not its document
 * total. A receipt that credited some other account moves neither side and
 * explains nothing: on isaflow_dev, Britech has 130 receipts worth R7,505,599
 * by the document basis against an AR control balance of −R329,700, and an item
 * of R7.5m there is an equal and opposite R7.5m of `unexplained_difference` —
 * the same shape of artefact as the control-account probe this change removed.
 *
 * So the SET and the document figure come from the shared basis, the AMOUNT is
 * the control-side figure, both are carried on the item, and where they differ
 * the gap is reported as an `unapplied_cash_off_control_account` excluded row
 * rather than absorbed. On books where the cash is where it should be the two
 * are equal and the reconciler and the listing tools agree exactly.
 */

import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import type { SubledgerRole } from '../gl/controlAccountService';
import { getUnappliedPaymentCash } from './unappliedPaymentCash';
import { round2 } from './reconciliationMath';
import { dropCancelledReversalPairs } from './orphanReversalPairs';
import { readOrphanControlPostings } from './orphanControlPostings';
import type { OffControlCash, UnappliedCashItem } from './unappliedCashTypes';

export type { OffControlCash, UnappliedCashItem } from './unappliedCashTypes';

export interface UnappliedCash {
  /** Mechanism 1 — a payment document exists, nothing is allocated against it. */
  withPaymentRecord: UnappliedCashItem[];
  /**
   * The APPLIED portion of the PARTLY applied payments.
   *
   * NOT a reconciling item: `unpostedDocumentService` owns this movement,
   * because it nets each payment's control posting against the document the
   * payment was allocated to. Counting it here as well double-counts. It is
   * returned so a caller can see the applied/unapplied split of a receipt
   * without a second query.
   *
   * NARROWED with the move to the shared basis, which returns only payments
   * that still have a remainder: a WHOLLY applied payment no longer appears
   * here. Nothing in this repo reads this field, and the split it describes is
   * only interesting where there is something left unapplied to split against.
   */
  appliedRecords: UnappliedCashItem[];
  /**
   * Mechanism 2 — every posted control-account movement that NO subledger
   * document references. Signed in the direction that closes the gap: a receipt
   * with no payment row reduces the control account, so it appears positive; an
   * invoice journal whose bill lost its link raises it, so it appears negative.
   */
  withoutPaymentRecord: UnappliedCashItem[];
  /**
   * Payments the shared basis counts as unapplied whose cash is not on a
   * control account — reported, never netted into an item. NOT a reconciling
   * item: it explains no part of the control difference, which is exactly why
   * it must not be added to one.
   */
  offControl: OffControlCash[];
  total: number;
  postedThrough: string | null;
}

const EMPTY: UnappliedCash = {
  appliedRecords: [],
  withPaymentRecord: [],
  withoutPaymentRecord: [],
  offControl: [],
  total: 0,
  postedThrough: null,
};

/** Which document tables belong to this subledger, and which leg holds the cash. */
interface RoleShape {
  paymentTable: 'customer_payments' | 'supplier_payments';
  /** The control leg of a receipt is a CREDIT for AR and a DEBIT for AP. */
  controlSide: 'credit' | 'debit';
}

function shapeFor(role: SubledgerRole): RoleShape | null {
  if (role === 'ar') return { paymentTable: 'customer_payments', controlSide: 'credit' };
  if (role === 'ap') return { paymentTable: 'supplier_payments', controlSide: 'debit' };
  return null;
}

function toItem(r: DbRow, amount: number, gross: number): UnappliedCashItem {
  return {
    id: String(r.id),
    documentNumber: r.document_number == null ? null : String(r.document_number),
    entityName: r.entity_name == null ? null : String(r.entity_name),
    documentDate: fmtDate(r.document_date as string | Date),
    amount,
    // A bare journal has no payment document behind it, so there is no
    // document-basis figure to disagree with the control-side one.
    documentUnapplied: amount,
    gross,
  };
}

function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function maxIso(rows: readonly DbRow[]): string | null {
  let max: string | null = null;
  for (const r of rows) {
    const raw = r.created_at;
    if (raw == null) continue;
    const iso = raw instanceof Date ? raw.toISOString() : String(raw);
    if (max === null || iso > max) max = iso;
  }
  return max;
}

/**
 * @param controlAccountIds every candidate control account, from
 *   `getControlAccountBalances`. An EMPTY array short-circuits: with no control
 *   account there is nothing for cash to be unapplied against, and running the
 *   query anyway would scan every journal line in the company.
 * @param asAtDate 'YYYY-MM-DD'. String throughout — no Date arithmetic.
 */
export async function getUnappliedControlCash(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
  controlAccountIds: readonly string[],
): Promise<UnappliedCash> {
  const shape = shapeFor(role);
  if (!shape || controlAccountIds.length === 0) return EMPTY;

  try {
    const ids = [...controlAccountIds];
    const isAr = role === 'ar';

    // ── Mechanism 1: a payment document with unallocated cash on control ────
    const payments = await getUnappliedPaymentCash(companyId, isAr ? 'ar' : 'ap', asAtDate, ids);

    // ── Mechanism 2: control movement no subledger document references ──────
    // The query, and every movement it deliberately does NOT report, are in
    // orphanControlPostings.ts.
    const orphanRows = await readOrphanControlPostings(companyId, isAr, asAtDate, ids);

    const { withPaymentRecord, appliedRecords, offControl } = payments;

    const withoutPaymentRecord = dropCancelledReversalPairs(orphanRows).map((r) => {
      const movement = round2(Number(r.control_credit ?? 0));
      // A bare journal has no document total; its own movement on the control
      // account IS its gross, so an item citing it can never exceed it.
      return toItem(r, movement, Math.abs(movement));
    });

    const total =
      withPaymentRecord.reduce((s, i) => s + i.amount, 0) +
      withoutPaymentRecord.reduce((s, i) => s + i.amount, 0);

    return {
      appliedRecords,
      withPaymentRecord,
      withoutPaymentRecord,
      offControl,
      total: round2(total),
      postedThrough: laterIso(payments.postedThrough, maxIso(orphanRows)),
    };
  } catch (err) {
    log.error('Failed to read unapplied control cash', { role, error: err }, 'accounting');
    throw err;
  }
}
