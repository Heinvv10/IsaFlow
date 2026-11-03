import { sql } from '@/lib/neon';

/**
 * Remuneration before taxable deductions. A negative annual-payment correction
 * cannot erase periodic remuneration paid in the same month (or vice versa).
 */
export function remunerationBeforeDeductions(
  periodic: number,
  annualPayment: number,
): { periodic: number; annualPayment: number; hadTableRemuneration: boolean } {
  const positivePeriodic = Math.max(0, periodic);
  const positiveAnnualPayment = Math.max(0, annualPayment);
  return {
    periodic: positivePeriodic,
    annualPayment: positiveAnnualPayment,
    hadTableRemuneration: positivePeriodic > 0 || positiveAnnualPayment > 0,
  };
}

/**
 * LATERAL aggregate for a payroll line aliased `l` and its header aliased `h`.
 * Keep this beside the TypeScript rule above: YTD, the approval gate, reopen
 * history and IRP5 completeness must identify pre-deduction remuneration alike.
 */
export function lineRemunerationBeforeDeductionsSql() {
  return sql.unsafe(`
    SELECT remuneration.*,
      remuneration.periodic_before_deductions > 0
        OR remuneration.annual_before_deductions > 0 AS had_table_remuneration
    FROM (
      SELECT
        CASE WHEN jsonb_array_length(COALESCE(l.component_breakdown, '[]'::jsonb)) > 0
          THEN amounts.periodic ELSE COALESCE(l.periodic_taxable, l.taxable_income)
        END AS periodic_before_deductions,
        CASE WHEN jsonb_array_length(COALESCE(l.component_breakdown, '[]'::jsonb)) > 0
          THEN amounts.annual ELSE COALESCE(l.annual_taxable, 0)
        END AS annual_before_deductions
      FROM (
        SELECT
          GREATEST(COALESCE(SUM((item->>'amount')::numeric) FILTER (
            WHERE (item->>'isTaxable')::boolean
              AND (pc.component_type = 'earning' OR item->>'componentId' LIKE 'synthetic:termination:%'
                OR (pc.id IS NULL AND regexp_replace(item->>'sarsSourceCode', '^[ \\t\\r\\n]+|[ \\t\\r\\n]+$', '', 'g') ~ '^3[0-8][0-9][0-9]$'))
              AND regexp_replace(item->>'sarsSourceCode', '^[ \\t\\r\\n]+|[ \\t\\r\\n]+$', '', 'g') <> '3605'
              AND regexp_replace(item->>'sarsSourceCode', '^[ \\t\\r\\n]+|[ \\t\\r\\n]+$', '', 'g') !~ '^39[0-9][0-9]$'
          ), 0), 0) AS periodic,
          GREATEST(COALESCE(SUM((item->>'amount')::numeric) FILTER (
            WHERE (item->>'isTaxable')::boolean
              AND (pc.component_type = 'earning' OR item->>'componentId' LIKE 'synthetic:termination:%'
                OR (pc.id IS NULL AND regexp_replace(item->>'sarsSourceCode', '^[ \\t\\r\\n]+|[ \\t\\r\\n]+$', '', 'g') ~ '^3[0-8][0-9][0-9]$'))
              AND regexp_replace(item->>'sarsSourceCode', '^[ \\t\\r\\n]+|[ \\t\\r\\n]+$', '', 'g') = '3605'
          ), 0), 0) AS annual
        FROM jsonb_array_elements(COALESCE(l.component_breakdown, '[]'::jsonb)) AS item
        LEFT JOIN payroll_components pc ON pc.id::text = item->>'componentId' AND pc.company_id = h.company_id
      ) amounts
    ) remuneration
  `);
}
