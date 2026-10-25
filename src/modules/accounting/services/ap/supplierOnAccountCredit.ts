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
 * THREE FIGURES, because one date basis is not enough (adversarial review, 2026-10-25). `credit` is as at a date.
 * `creditAllDates` counts every posted document whatever its date — the application and back-fill ceiling.
 * `lowestFromDate` is the LOWEST running credit at the date or at any later document date: a refund may not return
 * more than was on account when it happened, AND may not push any later point below zero — a refund dated later,
 * already recorded, has taken its share at its own date (statement lines allocated out of date order). The
 * all-dates figure is the last point of that series, so `lowestFromDate <= min(credit, creditAllDates)`. One
 * statement. Allocations carry no date: an applied amount counts at its payment's date.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface SupplierOnAccountCredit {
  /** As at the date asked for (every date when it was null). */
  credit: number;
  /** Every posted document of the supplier, whatever its date. */
  creditAllDates: number;
  /** The lowest running credit at the date asked for or at any later document date (all dates when null). */
  lowestFromDate: number;
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
    WITH by_day AS (
      SELECT sp.supplier_id AS sid, sp.payment_date AS d,
             SUM(sp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0))) AS amount
      FROM supplier_payments sp
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount_allocated) AS allocated
        FROM payment_allocations pa
        WHERE pa.payment_id = sp.id
      ) alloc ON TRUE
      WHERE sp.company_id = ${companyId}::UUID
        AND sp.supplier_id = ANY(${[...supplierIds]}::UUID[])
        AND sp.status IN ('processed', 'reconciled')
      GROUP BY sp.supplier_id, sp.payment_date
    ), running AS (
      SELECT sid, d, SUM(amount) OVER (PARTITION BY sid ORDER BY d) AS cum FROM by_day
    )
    SELECT s.id, s.name AS supplier_name, f.credit, f.credit_all_dates,
           LEAST(f.credit, COALESCE(f.lowest_later, f.credit)) AS lowest_from_date
    FROM suppliers s
    CROSS JOIN LATERAL (
      SELECT COALESCE((SELECT SUM(b.amount) FROM by_day b
                       WHERE b.sid = s.id AND (${asAt}::DATE IS NULL OR b.d <= ${asAt}::DATE)), 0) AS credit,
             COALESCE((SELECT SUM(b.amount) FROM by_day b WHERE b.sid = s.id), 0) AS credit_all_dates,
             (SELECT MIN(r.cum) FROM running r
              WHERE r.sid = s.id AND ${asAt}::DATE IS NOT NULL AND r.d > ${asAt}::DATE) AS lowest_later
    ) f
    WHERE s.company_id = ${companyId}::UUID
      AND s.id = ANY(${[...supplierIds]}::UUID[])
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), {
    credit: round2(Number(r.credit ?? 0)),
    creditAllDates: round2(Number(r.credit_all_dates ?? 0)),
    lowestFromDate: round2(Number(r.lowest_from_date ?? 0)),
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
  return hit ?? { credit: 0, creditAllDates: 0, lowestFromDate: 0, supplierName: 'this supplier' };
}
