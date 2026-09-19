/**
 * ONE definition of "unapplied payment", for every tool that reports one.
 *
 * There were two, and they disagreed. `list_unapplied_payments` counted
 * `total_amount − Σ payment_allocations` over `processed` and `reconciled`
 * payments, above a one-cent threshold, with no cap on the allocations.
 * `reconcile_subledger` counted each payment's POSTED CONTROL MOVEMENT minus
 * its allocations, over every non-cancelled payment, at a threshold of exactly
 * zero. Same question, same company, same date, two answers — and whichever a
 * reader ran first decided which one they believed.
 *
 * THE BASIS IS THE DOCUMENT, not the ledger. `total_amount − Σ allocations` is
 * what "attached to no bill" means, it is the figure the apply tools clear, and
 * it does not move when somebody reposts a journal. The ledger side of the same
 * money is the control-account movement, which `reconcile_subledger` reads
 * separately and compares AGAINST the documents — a comparison that is only
 * meaningful if the document side is defined by the document.
 *
 * THE THRESHOLD IS `round2(remainder) <> 0`, not an epsilon: the AP tool's
 * `> 0.01` discards a whole cent of real cash and the reconciler's `!== 0`
 * reports a ten-thousandth of one as a finding.
 *
 * ALLOCATIONS ARE CAPPED INTO `[0, max(total, 0)]`, which is two rules in one
 * expression. The upper bound stops an over-allocated payment appearing as
 * NEGATIVE unapplied cash quietly netting off a real remainder elsewhere in the
 * same total. The zero is what admits a REFUND (migration 681): a refund is a
 * payment row with a negative total and no allocations, and capping its
 * allocations at the negative total made its remainder exactly zero — so it
 * vanished from every figure built on this basis and the entity's on-account
 * credit read as though the cash had never come back. Its remainder is
 * NEGATIVE, which is the point: it nets against that entity's other remainders
 * wherever they are summed, with no reader having to remember to subtract it.
 * `kind` states which a row is, so nothing downstream infers a document type
 * from the sign.
 *
 * THE STATUS FILTER DIFFERS BY SIDE, and that is the one asymmetry that is
 * real. A `customer_payments` row is created already confirmed — the receipt
 * exists because the money arrived — so AR takes everything but `cancelled`. A
 * supplier payment has a lifecycle in front of it: `draft` and `approved` rows
 * have no journal, no cash has left the bank and nothing has touched the AP
 * control account, so listing one would invent a reconciling item. Both TOOLS
 * on a side now use the same filter, which is what was missing.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

export type UnappliedSide = 'ar' | 'ap';

/**
 * What kind of on-account entry a basis row is. A `'refund'` (migration 681)
 * carries a NEGATIVE `total_amount` and no allocations; everything else is
 * positive cash awaiting application.
 */
export type UnappliedPaymentKind = 'payment' | 'refund';

export interface UnappliedPaymentBasisRow {
  paymentId: string;
  /** Payment / receipt number, '' when the row carries none. */
  paymentNumber: string;
  paymentDate: string;
  /** Null when the counterparty row is missing or soft-deleted. */
  entityId: string | null;
  entityName: string | null;
  /** Whether the counterparty resolved. Stated BY the query, never inferred. */
  attributed: boolean;
  totalAmount: number;
  /** Σ allocations, capped into `[0, max(totalAmount, 0)]`. */
  allocatedAmount: number;
  /**
   * `totalAmount − allocatedAmount`, rounded to cents. NEVER zero on a row, and
   * NEGATIVE on a refund — cash the company sent back, which nets against the
   * same entity's other remainders rather than adding to them.
   */
  unappliedAmount: number;
  /**
   * `'refund'` for a negative on-account entry (migration 681), `'payment'` for
   * everything else. Stated by the query rather than inferred from the sign, so
   * a reader that must render the two differently is not deriving a document
   * type from an arithmetic accident.
   */
  kind: UnappliedPaymentKind;
  status: string;
  reference: string | null;
  description: string | null;
  /** The journal that put this cash on the control account, when there is one. */
  journalEntryId: string | null;
  /** ISO-8601, or null. Never now(). */
  createdAt: string | null;
}

/**
 * Counted and summed by a SEPARATE aggregate, never by measuring `rows`.
 *
 * `buildEnvelope` checks `rowsTotal + excludedCount === universeTotal`, and a
 * universe derived from the very rows it is checking makes that identity an
 * algebraic tautology — CONTRACTS.md §1 names the shape. The aggregate carries
 * the same predicate and is a second statement, so a row query that silently
 * drops rows breaks the identity instead of moving it.
 */
export interface UnappliedPaymentTotals {
  /** Every payment with an unapplied remainder, attributed or not. */
  universeTotal: number;
  /** The ones whose counterparty resolved. */
  rowsTotal: number;
  totalUnapplied: number;
  totalUnattributed: number;
  /** MAX(created_at) over the payments counted. Never now(). */
  postedThrough: string | null;
}

export interface UnappliedPaymentBasis {
  /** Every unapplied payment, oldest first. Unpaged: the caller pages it. */
  rows: UnappliedPaymentBasisRow[];
  totals: UnappliedPaymentTotals;
  /**
   * MAX(created_at) over the side's allocation table. An allocation written a
   * minute ago changes an unapplied amount without touching the payment row.
   */
  allocationsPostedThrough: string | null;
}

function toIso(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return raw instanceof Date ? raw.toISOString() : String(raw);
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

/**
 * @param asAt 'YYYY-MM-DD'. String throughout — no Date arithmetic anywhere on
 *   this path; SAST is UTC+2 and this repo has a live UTC-rollback defect class.
 */
export async function getUnappliedPaymentBasis(
  companyId: string,
  side: UnappliedSide,
  asAt: string,
): Promise<UnappliedPaymentBasis> {
  // AR and AP are SEPARATE queries rather than one branching on a boolean
  // parameter: that form type-checked, ran without error and returned nothing
  // on data where a manual join found the rows.
  //
  // WHY THE OUTER JOIN'S ON CLAUSE CARRIES PREDICATES. A predicate that must
  // RESTRICT belongs in WHERE; inside an outer join's ON it restricts nothing
  // and the unmatched row survives with NULLs. These are not restricting. They
  // define which counterparty row counts as a match — same tenant, not
  // soft-deleted — and a payment whose counterparty fails them is MEANT to
  // survive unmatched, because the cash is real whether or not the supplier
  // record still is. `attributed` carries that outcome to the caller, and no
  // NULL reaches any arithmetic.
  const rows = (await (side === 'ar'
    ? sql`
      SELECT cp.id,
             cp.payment_number AS document_number,
             cp.payment_date AS document_date,
             cp.client_id AS entity_id,
             c.name AS entity_name,
             (c.id IS NOT NULL) AS attributed,
             cp.total_amount,
             cp.status,
             cp.bank_reference AS reference,
             cp.description,
             cp.gl_journal_entry_id,
             cp.created_at,
             cp.payment_method,
             COALESCE(alloc.allocated, 0) AS allocated_amount
      FROM customer_payments cp
      LEFT JOIN customers c
        ON c.id = cp.client_id
       AND c.company_id = cp.company_id
       AND c.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT SUM(cpa.amount_allocated) AS allocated
        FROM customer_payment_allocations cpa
        WHERE cpa.payment_id = cp.id
      ) alloc ON TRUE
      WHERE cp.company_id = ${companyId}::UUID
        AND cp.status <> 'cancelled'
        AND cp.payment_date <= ${asAt}::DATE
        AND ROUND(cp.total_amount
                  - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0)), 2) <> 0
      ORDER BY cp.payment_date ASC, cp.id ASC
    `
    : sql`
      SELECT sp.id,
             sp.payment_number AS document_number,
             sp.payment_date AS document_date,
             sp.supplier_id AS entity_id,
             s.name AS entity_name,
             (s.id IS NOT NULL) AS attributed,
             sp.total_amount,
             sp.status,
             sp.reference,
             sp.description,
             sp.gl_journal_entry_id,
             sp.created_at,
             sp.payment_method,
             COALESCE(alloc.allocated, 0) AS allocated_amount
      FROM supplier_payments sp
      LEFT JOIN suppliers s
        ON s.id = sp.supplier_id
       AND s.company_id = sp.company_id
       AND s.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount_allocated) AS allocated
        FROM payment_allocations pa
        WHERE pa.payment_id = sp.id
      ) alloc ON TRUE
      WHERE sp.company_id = ${companyId}::UUID
        AND sp.status IN ('processed', 'reconciled')
        AND sp.payment_date <= ${asAt}::DATE
        AND ROUND(sp.total_amount
                  - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0)), 2) <> 0
      ORDER BY sp.payment_date ASC, sp.id ASC
    `)) as DbRow[];

  // Totals and completeness over the WHOLE population, by a second statement
  // carrying the same predicate. See UnappliedPaymentTotals.
  const totalsRows = (await (side === 'ar'
    ? sql`
      SELECT COUNT(*)::INT AS universe_total,
             COUNT(*) FILTER (WHERE c.id IS NOT NULL)::INT AS rows_total,
             COALESCE(SUM(cp.total_amount
                          - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0)))
                      FILTER (WHERE c.id IS NOT NULL), 0) AS total_unapplied,
             COALESCE(SUM(cp.total_amount
                          - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0)))
                      FILTER (WHERE c.id IS NULL), 0) AS total_unattributed,
             MAX(cp.created_at) AS posted_through
      FROM customer_payments cp
      LEFT JOIN customers c
        ON c.id = cp.client_id
       AND c.company_id = cp.company_id
       AND c.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT SUM(cpa.amount_allocated) AS allocated
        FROM customer_payment_allocations cpa
        WHERE cpa.payment_id = cp.id
      ) alloc ON TRUE
      WHERE cp.company_id = ${companyId}::UUID
        AND cp.status <> 'cancelled'
        AND cp.payment_date <= ${asAt}::DATE
        AND ROUND(cp.total_amount
                  - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0)), 2) <> 0
    `
    : sql`
      SELECT COUNT(*)::INT AS universe_total,
             COUNT(*) FILTER (WHERE s.id IS NOT NULL)::INT AS rows_total,
             COALESCE(SUM(sp.total_amount
                          - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0)))
                      FILTER (WHERE s.id IS NOT NULL), 0) AS total_unapplied,
             COALESCE(SUM(sp.total_amount
                          - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0)))
                      FILTER (WHERE s.id IS NULL), 0) AS total_unattributed,
             MAX(sp.created_at) AS posted_through
      FROM supplier_payments sp
      LEFT JOIN suppliers s
        ON s.id = sp.supplier_id
       AND s.company_id = sp.company_id
       AND s.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount_allocated) AS allocated
        FROM payment_allocations pa
        WHERE pa.payment_id = sp.id
      ) alloc ON TRUE
      WHERE sp.company_id = ${companyId}::UUID
        AND sp.status IN ('processed', 'reconciled')
        AND sp.payment_date <= ${asAt}::DATE
        AND ROUND(sp.total_amount
                  - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0)), 2) <> 0
    `)) as DbRow[];
  // A COUNT with no GROUP BY always returns exactly one row from Postgres; the
  // fallback is only for a mocked `sql` in the tool-manifest sweep, which
  // answers every query with [].
  const totals = totalsRows[0] ?? {};

  // `payment_allocations` / `customer_payment_allocations` carry no company_id
  // of their own, so the scope comes through the payment.
  const allocRows = (await (side === 'ar'
    ? sql`
      SELECT MAX(cpa.created_at) AS posted_through
      FROM customer_payment_allocations cpa
      JOIN customer_payments cp ON cp.id = cpa.payment_id
      WHERE cp.company_id = ${companyId}::UUID
    `
    : sql`
      SELECT MAX(pa.created_at) AS posted_through
      FROM payment_allocations pa
      JOIN supplier_payments sp ON sp.id = pa.payment_id
      WHERE sp.company_id = ${companyId}::UUID
    `)) as DbRow[];

  const out: UnappliedPaymentBasisRow[] = [];
  for (const r of rows) {
    const totalAmount = Number(r.total_amount ?? 0);
    // `Math.max(totalAmount, 0)` is the allocation cap, and the zero is what
    // makes a REFUND work. The cap exists so an over-allocated payment cannot
    // read as negative unapplied cash quietly netting off a real remainder
    // elsewhere in the same total. Capping at a NEGATIVE total instead makes
    // the remainder exactly zero, which dropped every refund out of every
    // figure built on this basis — the credit then read as though the cash had
    // never come back. A refund carries no allocations, so the cap is 0 and the
    // remainder is the refund itself.
    const allocatedAmount = Math.min(Number(r.allocated_amount ?? 0), Math.max(totalAmount, 0));
    const unappliedAmount = round2(totalAmount - allocatedAmount);
    // The SQL filter is `<> 0` at full precision; this is the cents threshold.
    // Both are needed: the first keeps the scan small, the second is the rule.
    // NOT `<= 0` any more: a refund's remainder is negative and is a row.
    if (unappliedAmount === 0) continue;
    const attributed = r.attributed === true;
    out.push({
      paymentId: String(r.id),
      paymentNumber: r.document_number ? String(r.document_number) : '',
      paymentDate: fmtDate(r.document_date as string | Date),
      entityId: attributed && r.entity_id ? String(r.entity_id) : null,
      entityName: attributed && r.entity_name != null ? String(r.entity_name) : null,
      attributed,
      totalAmount,
      allocatedAmount: round2(allocatedAmount),
      unappliedAmount,
      kind: r.payment_method === 'refund' ? 'refund' : 'payment',
      status: String(r.status ?? ''),
      reference: r.reference ? String(r.reference) : null,
      description: r.description ? String(r.description) : null,
      journalEntryId: r.gl_journal_entry_id ? String(r.gl_journal_entry_id) : null,
      createdAt: toIso(r.created_at),
    });
  }

  return {
    rows: out,
    totals: {
      universeTotal: Number(totals.universe_total ?? 0),
      rowsTotal: Number(totals.rows_total ?? 0),
      totalUnapplied: round2(Number(totals.total_unapplied ?? 0)),
      totalUnattributed: round2(Number(totals.total_unattributed ?? 0)),
      postedThrough: toIso(totals.posted_through),
    },
    allocationsPostedThrough: toIso(allocRows[0]?.posted_through),
  };
}
