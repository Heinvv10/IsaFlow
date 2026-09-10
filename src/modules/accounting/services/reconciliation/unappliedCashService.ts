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
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import type { SubledgerRole } from '../gl/controlAccountService';
import { dropCancelledReversalPairs } from './orphanReversalPairs';

export interface UnappliedCashItem {
  /** Payment id (mechanism 1) or journal-entry id (mechanism 2). */
  id: string;
  /** Payment number or journal entry number. */
  documentNumber: string | null;
  /** Customer / supplier name where the row carries one; null for a bare journal. */
  entityName: string | null;
  /** 'YYYY-MM-DD'. */
  documentDate: string;
  /** The UNAPPLIED portion, always positive. */
  amount: number;
}

export interface UnappliedCash {
  /** Mechanism 1 — a payment document exists, nothing is allocated against it. */
  withPaymentRecord: UnappliedCashItem[];
  /**
   * The APPLIED portion of the same payments.
   *
   * NOT a reconciling item: `unpostedDocumentService` owns this movement,
   * because it nets each payment's control posting against the document the
   * payment was allocated to. Counting it here as well double-counts. It is
   * returned so a caller can see the applied/unapplied split of a receipt
   * without a second query.
   */
  appliedRecords: UnappliedCashItem[];
  /**
   * Mechanism 2 — every posted control-account movement that NO subledger
   * document references. Signed in the direction that closes the gap: a receipt
   * with no payment row reduces the control account, so it appears positive; an
   * invoice journal whose bill lost its link raises it, so it appears negative.
   */
  withoutPaymentRecord: UnappliedCashItem[];
  total: number;
  postedThrough: string | null;
}

const EMPTY: UnappliedCash = {
  appliedRecords: [],
  withPaymentRecord: [],
  withoutPaymentRecord: [],
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

function toItem(r: DbRow, amount: number): UnappliedCashItem {
  return {
    id: String(r.id),
    documentNumber: r.document_number == null ? null : String(r.document_number),
    entityName: r.entity_name == null ? null : String(r.entity_name),
    documentDate: fmtDate(r.document_date as string | Date),
    amount,
  };
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
    //
    // AR and AP run as SEPARATE queries rather than one query branching on a
    // boolean parameter. The parameterised version type-checked, ran without
    // error, and returned NOTHING on data where a manual join found the row —
    // a query that is wrong and silent is the worst outcome available on an
    // assurance endpoint, and no test that mocks `sql` can see it.
    const payRows = (await (isAr
      ? sql`
        SELECT p.id, p.payment_number AS document_number, c.name AS entity_name,
               p.payment_date AS document_date, p.created_at,
               COALESCE(SUM(jl.credit), 0) AS control_credit,
               COALESCE((SELECT SUM(a.amount_allocated)
                         FROM customer_payment_allocations a
                         WHERE a.payment_id = p.id), 0) AS allocated
        FROM customer_payments p
        JOIN customers c ON c.id = p.client_id AND c.company_id = ${companyId}::UUID
        JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted'
                                  AND je.entry_date <= ${asAtDate}::DATE
        JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                AND jl.company_id = ${companyId}::UUID
                                AND jl.gl_account_id = ANY(${ids}::uuid[])
        WHERE p.company_id = ${companyId}::UUID
          AND p.status <> 'cancelled'
        GROUP BY p.id, p.payment_number, c.name, p.payment_date, p.created_at
        ORDER BY p.payment_date, p.id
      `
      : sql`
        SELECT p.id, p.payment_number AS document_number, s.name AS entity_name,
               p.payment_date AS document_date, p.created_at,
               COALESCE(SUM(jl.debit), 0) AS control_credit,
               COALESCE((SELECT SUM(a.amount_allocated)
                         FROM payment_allocations a
                         WHERE a.payment_id = p.id), 0) AS allocated
        FROM supplier_payments p
        JOIN suppliers s ON s.id = p.supplier_id AND s.company_id = ${companyId}::UUID
        JOIN gl_journal_entries je ON je.id = p.gl_journal_entry_id
                                  AND je.company_id = ${companyId}::UUID
                                  AND je.status = 'posted'
                                  AND je.entry_date <= ${asAtDate}::DATE
        JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                AND jl.company_id = ${companyId}::UUID
                                AND jl.gl_account_id = ANY(${ids}::uuid[])
        WHERE p.company_id = ${companyId}::UUID
          AND p.status <> 'cancelled'
        GROUP BY p.id, p.payment_number, s.name, p.payment_date, p.created_at
        ORDER BY p.payment_date, p.id
      `)) as DbRow[];

    // ── Mechanism 2: control movement no subledger document references ──────
    //
    // Taken SIGNED, in the control account's own direction, and negated so it
    // reads as "what has to be added to the control balance to reach the
    // subledger". The two partitions — documents that claim a journal, journals
    // no document claims — must cover the control account exactly once each, or
    // the decomposition double-counts and the residual never reaches zero.
    //
    // The reversal a SOFT-DELETE posts is the one control movement no document
    // will ever claim and that is not a reconciling item. The invoice keeps
    // pointing at the ORIGINAL entry so the undo can find it, so the reversal
    // passes every `NOT EXISTS` below and would land here as an orphan for the
    // full gross value of the document — on the AR reconciler and the AP
    // reconciler, permanently, for every deleted invoice. The pair already
    // contributes zero to the decomposition: `unpostedDocumentService` still
    // counts the deleted document AND its original journal (its GL half reads
    // only `jl.journal_entry_id = ci.gl_journal_entry_id`, never the reversal),
    // so it nets to nothing, and the control balance has moved by exactly the
    // same amount the sub-ledger dropped. Counting the reversal here re-opens
    // a gap both sides had closed. `soft_delete_journal_reversals` (migration
    // 653) records exactly which entries those are, and `idx_sdjr_reversal_entry`
    // indexes this direction.
    const orphanRows = (await (isAr
      ? sql`
        SELECT je.id, je.reversal_of_id, je.entry_number AS document_number,
               NULL::text AS entity_name,
               je.entry_date AS document_date, je.created_at,
               COALESCE(SUM(jl.credit - jl.debit), 0) AS control_credit
        FROM gl_journal_entries je
        JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                AND jl.company_id = ${companyId}::UUID
                                AND jl.gl_account_id = ANY(${ids}::uuid[])
        WHERE je.company_id = ${companyId}::UUID
          AND je.status = 'posted'
          AND je.entry_date <= ${asAtDate}::DATE
          AND NOT EXISTS (SELECT 1 FROM customer_invoices d
                          WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id)
          AND NOT EXISTS (SELECT 1 FROM customer_payments d
                          WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id)
          AND NOT EXISTS (SELECT 1 FROM credit_notes d
                          WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id)
          AND NOT EXISTS (SELECT 1 FROM soft_delete_journal_reversals r
                          WHERE r.company_id = ${companyId}::UUID
                            AND r.reversal_journal_entry_id = je.id)
        GROUP BY je.id, je.reversal_of_id, je.entry_number, je.entry_date, je.created_at
        HAVING COALESCE(SUM(jl.credit - jl.debit), 0) <> 0
        ORDER BY je.entry_date, je.id
      `
      : sql`
        SELECT je.id, je.reversal_of_id, je.entry_number AS document_number,
               NULL::text AS entity_name,
               je.entry_date AS document_date, je.created_at,
               COALESCE(SUM(jl.debit - jl.credit), 0) AS control_credit
        FROM gl_journal_entries je
        JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                AND jl.company_id = ${companyId}::UUID
                                AND jl.gl_account_id = ANY(${ids}::uuid[])
        WHERE je.company_id = ${companyId}::UUID
          AND je.status = 'posted'
          AND je.entry_date <= ${asAtDate}::DATE
          AND NOT EXISTS (SELECT 1 FROM supplier_invoices d
                          WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id)
          AND NOT EXISTS (SELECT 1 FROM supplier_payments d
                          WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id)
          AND NOT EXISTS (SELECT 1 FROM credit_notes d
                          WHERE d.company_id = ${companyId}::UUID AND d.gl_journal_entry_id = je.id)
          AND NOT EXISTS (SELECT 1 FROM soft_delete_journal_reversals r
                          WHERE r.company_id = ${companyId}::UUID
                            AND r.reversal_journal_entry_id = je.id)
        GROUP BY je.id, je.reversal_of_id, je.entry_number, je.entry_date, je.created_at
        HAVING COALESCE(SUM(jl.debit - jl.credit), 0) <> 0
        ORDER BY je.entry_date, je.id
      `)) as DbRow[];

    const withPaymentRecord: UnappliedCashItem[] = [];
    const appliedRecords: UnappliedCashItem[] = [];
    for (const r of payRows) {
      const posted = Number(r.control_credit ?? 0);
      const allocated = Math.min(Number(r.allocated ?? 0), posted);
      const unapplied = Math.round((posted - allocated) * 100) / 100;
      // A zero-amount row reads to an agent as a finding and is not one, so
      // each payment lands in whichever bucket it actually has value in.
      if (unapplied !== 0) withPaymentRecord.push(toItem(r, unapplied));
      if (allocated !== 0) appliedRecords.push(toItem(r, Math.round(allocated * 100) / 100));
    }

    const withoutPaymentRecord = dropCancelledReversalPairs(orphanRows).map((r) =>
      toItem(r, Math.round(Number(r.control_credit ?? 0) * 100) / 100),
    );

    const total =
      withPaymentRecord.reduce((s, i) => s + i.amount, 0) +
      withoutPaymentRecord.reduce((s, i) => s + i.amount, 0);

    return {
      appliedRecords,
      withPaymentRecord,
      withoutPaymentRecord,
      total: Math.round(total * 100) / 100,
      postedThrough: maxIso([...payRows, ...orphanRows]),
    };
  } catch (err) {
    log.error('Failed to read unapplied control cash', { role, error: err }, 'accounting');
    throw err;
  }
}
