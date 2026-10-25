/**
 * What a supplier has sitting on account — the ONE figure a refund and an application of posted cash are both
 * judged against (ap/supplierCreditLock).
 *
 * The SAME basis as `shared/unappliedPaymentBasis` — document total minus allocations, over `processed` and
 * `reconciled` rows — per supplier, as a single netted figure. It is not a fourth definition of unapplied cash: the
 * predicate is copied clause for clause, and the integration suite proves the two agree on the same tenant.
 *
 * `GREATEST(sp.total_amount, 0)` is the allocation cap and it is the whole reason this cannot reuse the plain
 * `LEAST(allocated, total_amount)` form. On a refund that form caps the allocations at the NEGATIVE total, so the
 * remainder computes to exactly zero and an earlier refund stops reducing the credit.
 *
 * TWO FIGURES, because one date basis is not enough (adversarial review, 2026-10-25). `credit` is as at a date:
 * a refund may not return more than was on account when it happened. `creditAllDates` counts every posted
 * document whatever its date: a refund dated LATER, already recorded, has already taken its share, so a second
 * refund dated earlier (statement lines allocated out of date order) must be judged against both, and an
 * application or the back-fill against the all-dates figure. Both come from one statement.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface SupplierOnAccountCredit {
  /** As at the date asked for (every date when it was null). */
  credit: number;
  /** Every posted document of the supplier, whatever its date. */
  creditAllDates: number;
  supplierName: string;
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

/**
 * Each supplier's on-account credit, in one statement. A supplier not found (another tenant, or a bad id) is absent
 * from the map.
 *
 * @param asAt 'YYYY-MM-DD'. String throughout: SAST is UTC+2 and this repo has a live UTC-rollback defect class
 *   around Date arithmetic. `null`: every date (then `credit === creditAllDates`).
 */
export async function getSupplierOnAccountCredits(
  companyId: string,
  supplierIds: readonly string[],
  asAt: string | null,
): Promise<Map<string, SupplierOnAccountCredit>> {
  if (supplierIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT s.id, s.name AS supplier_name,
           COALESCE(SUM(rem.amount) FILTER (
             WHERE ${asAt}::DATE IS NULL OR sp.payment_date <= ${asAt}::DATE), 0) AS credit,
           COALESCE(SUM(rem.amount), 0) AS credit_all_dates
    FROM suppliers s
    LEFT JOIN supplier_payments sp
      ON sp.supplier_id = s.id
     AND sp.company_id = s.company_id
     AND sp.status IN ('processed', 'reconciled')
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount_allocated) AS allocated
      FROM payment_allocations pa
      WHERE pa.payment_id = sp.id
    ) alloc ON TRUE
    CROSS JOIN LATERAL (
      SELECT sp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0)) AS amount
    ) rem
    WHERE s.company_id = ${companyId}::UUID
      AND s.id = ANY(${[...supplierIds]}::UUID[])
    GROUP BY s.id, s.name
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), {
    credit: round2(Number(r.credit ?? 0)),
    creditAllDates: round2(Number(r.credit_all_dates ?? 0)),
    supplierName: r.supplier_name ? String(r.supplier_name) : 'this supplier',
  }]));
}

/** One supplier's figure (zero for a supplier not found, named "this supplier"). */
export async function getSupplierOnAccountCredit(
  companyId: string,
  supplierId: string,
  asAt: string | null,
): Promise<SupplierOnAccountCredit> {
  const hit = (await getSupplierOnAccountCredits(companyId, [supplierId], asAt)).get(supplierId.toLowerCase());
  return hit ?? { credit: 0, creditAllDates: 0, supplierName: 'this supplier' };
}
