/**
 * The travel allowance and company vehicle on a certificate (wave 5 FB review). PAYE is withheld on part of each
 * (fringeBenefits.ts: 80%, or 20%), so a certificate that shows them as plain income in 3601 contradicts the tax on it.
 *
 * SARS e@syFile Employer Reconciliation BRS V25.3.0 (Jun-26):
 *  - 3701 (p. 47, 105) is the cash travel allowance, certified under its own code, outside 3601.
 *  - 3802 (p. 105) is the vehicle benefit, already certified as a non-cash benefit (payrollNonCashFiling).
 *  - 4582 (p. 105; rules p. 54, 56) "The portion (80 or 20%) of the allowance and benefit which is subject to PAYE",
 *    for 3701, 3802 and 3816. From the 2019 year of assessment it is mandatory when the sum of 3701, 3802 and 3816 is
 *    above zero and must not be below 20% or above 80% of that sum.
 *  - Reimbursive travel (wave 6 RI; V25.3.0, V23.0.0 agrees): 3702 (p. 86) the part within the prescribed rate a km, 3722
 *    (p. 90, from 2019) the excess above it, 3703 (p. 86) the full reimbursement when the rate is at or below the prescribed
 *    rate and nothing else is paid for travel. Certificate rules (p. 50): 3703 "must not be reflected on an IRP5/IT3(a)
 *    certificate together with code 3701 and/or 3702 and/or 3722" and its value "must be included in the value of code 3702";
 *    "If code 3722/3772 is greater than zero, then code 3702/3752 must be greater than zero". 3703 is non-taxable income, so
 *    3696 is mandatory with it (p. 51; easyFileExportService). The run line already carries each code (splitTravelRows); the
 *    year's certificate may meet them together (a 3703 month and a 3702 month), so 3703 folds into 3702 here.
 * The portion is exact: each line stores `payeIncludedAmount` (what the calculator took). A line from before the rate was
 * stored taxed the whole amount, so it counts at 100% and the certificate clamps into SARS's 20-80% band with a warning.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { formatMoney } from '@/lib/money/formatMoney';
import { contractorLineFlag } from './payrollOutsideTables';

export interface AllowanceFiling {
  /** Cash 3701 paid in the year: certified under 3701, not in 3601. */
  cash3701: number;
  /** The taxable part of cash3701: what SARS's 20-80% band of 4582 is judged on (a non-taxable 3701 is not in it). */
  taxableCash3701: number;
  /** Non-cash 3802 in the year (also in the non-cash benefits list). */
  vehicle3802: number;
  /** The part of 3701 + 3802 that PAYE was withheld on. */
  payeIncluded: number;
  /** Lines costed before the inclusion rate was stored (PAYE was on the whole amount). */
  legacyLines: number;
  /** Reimbursive travel paid in the year by code (RI): within the prescribed rate (3702, 3703) and the taxed excess (3722). */
  travel3702: number;
  travel3703: number;
  travel3722: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function listRunAllowanceFiling(
  companyId: string, bounds: { start: string; end: string }, employeeId: string | null = null,
): Promise<Map<string, AllowanceFiling>> {
  const rows = (await sql`
    SELECT l.employee_id,
      COALESCE(SUM((item->>'amount')::numeric) FILTER (WHERE code = '3701' AND item->>'isNonCash' IS DISTINCT FROM 'true'), 0)::numeric AS cash_3701,
      COALESCE(SUM((item->>'amount')::numeric) FILTER (WHERE code = '3701' AND item->>'isNonCash' IS DISTINCT FROM 'true' AND item->>'isTaxable' = 'true'), 0)::numeric AS taxable_3701,
      COALESCE(SUM((item->>'amount')::numeric) FILTER (WHERE code = '3802' AND item->>'isNonCash' = 'true'), 0)::numeric AS vehicle_3802,
      COALESCE(SUM(CASE WHEN counted THEN COALESCE((item->>'payeIncludedAmount')::numeric, (item->>'amount')::numeric) ELSE 0 END), 0)::numeric AS included,
      COUNT(*) FILTER (WHERE counted AND item->>'payeIncludedAmount' IS NULL)::int AS legacy,
      COALESCE(SUM((item->>'amount')::numeric) FILTER (WHERE code = '3702'), 0)::numeric AS travel_3702,
      COALESCE(SUM((item->>'amount')::numeric) FILTER (WHERE code = '3703'), 0)::numeric AS travel_3703,
      COALESCE(SUM((item->>'amount')::numeric) FILTER (WHERE code = '3722'), 0)::numeric AS travel_3722
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    CROSS JOIN LATERAL (
      SELECT i AS item, regexp_replace(i->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS code,
        -- 4582 counts what the band sum counts: a taxable cash 3701 and a taxable NON-CASH 3802 (a hand-assigned cash 3802 is plain income).
        (i->>'isTaxable' = 'true'
          AND ((regexp_replace(i->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3701' AND i->>'isNonCash' IS DISTINCT FROM 'true')
            OR (regexp_replace(i->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3802' AND i->>'isNonCash' = 'true'))) AS counted
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.component_breakdown) = 'array' THEN l.component_breakdown ELSE '[]'::jsonb END) AS i
    ) c
    WHERE h.company_id = ${companyId}::uuid
      AND ${sql.unsafe(payRunFinalSql('h'))}
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
      AND (${employeeId}::uuid IS NULL OR l.employee_id = ${employeeId}::uuid)
      AND c.code IN ('3701', '3802', '3702', '3703', '3722')
      -- An independent contractor's line (PAYE treatment none): its fees, 3701 included, are certified as 3616, not as an allowance.
      AND NOT COALESCE(l.validation_results @> ${contractorLineFlag}::jsonb, false)
    GROUP BY l.employee_id
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.employee_id), {
    cash3701: round2(Number(r.cash_3701)), taxableCash3701: round2(Number(r.taxable_3701)), vehicle3802: round2(Number(r.vehicle_3802)),
    payeIncluded: round2(Number(r.included)), legacyLines: Number(r.legacy),
    travel3702: round2(Number(r.travel_3702)), travel3703: round2(Number(r.travel_3703)), travel3722: round2(Number(r.travel_3722)),
  }] as const));
}

/** The 3701 income field and 4582 for a certificate, and what to say when 4582 had to be clamped into SARS's band. */
export function allowanceCertificateFields(a: AllowanceFiling | undefined, who = ''): {
  cashAllowances: { sourceCode: string; amount: number }[]; paye4582?: number; warnings: string[];
} {
  if (!a) return { cashAllowances: [], warnings: [] };
  // Certified in whole rand (the writer drops cents): what is under R1 stays in 3601, never vanishes from both.
  const cashAllowances = [...(Math.floor(a.cash3701) >= 1 ? [{ sourceCode: '3701', amount: Math.floor(a.cash3701) }] : []), ...travelFields(a)];
  // The certified values drop cents, and SARS's 20-80% band is judged on them.
  const sum = Math.floor(a.taxableCash3701) + Math.floor(a.vehicle3802);
  if (sum <= 0) return { cashAllowances, warnings: [] };
  const lo = Math.ceil(sum * 0.2);
  const hi = Math.floor(sum * 0.8);
  const exact = Math.floor(a.payeIncluded);
  const paye4582 = Math.min(hi, Math.max(lo, exact));
  const warnings = paye4582 === exact ? [] : [
    `${who}: code 4582 is ${formatMoney(paye4582)}, not the ${formatMoney(a.payeIncluded)} PAYE was withheld on, because SARS accepts only 20% to 80% of codes 3701 + 3802 `
    + `(BRS V25.3.0 p. 54)${a.legacyLines > 0 ? ` and ${a.legacyLines} line(s) were costed before the inclusion rate was stored, taxing the whole allowance` : ''}. Check the certificate before filing it.`,
  ];
  return { cashAllowances, paye4582, warnings };
}

/**
 * 3702 / 3703 / 3722 for a certificate, in whole rand (BRS p. 50, 86, 90): 3703 only when no 3701, 3702 or 3722 is certified
 * beside it, else its value is added to 3702. What is under R1 is not certified and stays in 3601.
 */
function travelFields(a: AllowanceFiling): { sourceCode: string; amount: number }[] {
  const excess = Math.floor(a.travel3722);
  const alone = Math.floor(a.cash3701) < 1 && Math.floor(a.travel3702) < 1 && excess < 1;
  const within = Math.floor(alone ? a.travel3703 : a.travel3702 + a.travel3703);
  return [
    ...(within >= 1 ? [{ sourceCode: alone ? '3703' : '3702', amount: within }] : []),
    ...(excess >= 1 ? [{ sourceCode: '3722', amount: excess }] : []),
  ];
}
