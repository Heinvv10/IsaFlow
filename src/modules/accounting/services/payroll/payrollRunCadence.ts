/**
 * A weekly or fortnightly run's line cadences (wave 6 FQc): per employee, what the month's EARLIER final runs of the
 * same frequency already paid (same EMP201 month, before this run in pay order, payrollRunOrder), for
 *  - UIF: the remuneration they levied it on, so this run levies only the room left under the month's ceiling
 *    (uifEngine; UIC Act s6(1)(a)). Rebuilt from each line's breakdown as the calculator built it: the earnings flagged
 *    UIF-applicable, at their PAYE share where they carry one (payeIncludedAmount). A weekly or fortnightly line has no
 *    fringe benefit (refused, §0a.11), so every such share is stored;
 *  - ETI: their ETI parts (ETI_MONTH_PENDING), when this run closes the month (payrollLineEtiMonth).
 * A monthly run gets no cadence: its lines are costed exactly as before.
 * NAMED LIMIT: an earning's type is read from today's payroll_components (as payrollYearToDate reads it); a component
 * deleted since counts nothing.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { runIsBeforeSql } from './payrollRunOrder';
import { closesPayMonth, payDateOf } from './payFrequencyPeriods';
import { addEtiMonthParts, ETI_MONTH_PENDING, NO_ETI_PARTS } from './payrollLineEtiMonth';
import type { EtiMonthParts, LineCadence, PayFrequency, PayrollPeriod } from './payrollTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

function partsOf(raw: unknown): EtiMonthParts | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o.remuneration !== 'number' || typeof o.wageCents !== 'number' || typeof o.overtimeHours !== 'number') return null;
  return {
    remuneration: o.remuneration, wageCents: o.wageCents, overtimeHours: o.overtimeHours,
    ordinaryHours: typeof o.ordinaryHours === 'number' ? o.ordinaryHours : null,
  };
}

/** By employee id (every id given gets one); empty for a monthly run. */
export async function loadLineCadences(
  companyId: string, runId: string,
  run: { frequency: PayFrequency; period: PayrollPeriod; runDate: string | null },
  employeeIds: string[],
): Promise<Map<string, LineCadence>> {
  const { frequency, period } = run;
  if (frequency === 'monthly' || !period.start || !period.end || employeeIds.length === 0) return new Map();
  const payDate = payDateOf(period, run.runDate) ?? period.end;
  const closes = closesPayMonth(frequency, payDate);
  const rows = (await sql`
    SELECT l.employee_id::text AS employee_id,
           COALESCE(SUM(u.base), 0)::float8 AS uif_base,
           jsonb_agg(w.parts) FILTER (WHERE w.parts IS NOT NULL) AS eti_parts
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      CROSS JOIN LATERAL (
        SELECT SUM(COALESCE((item->>'payeIncludedAmount')::numeric, (item->>'amount')::numeric)) AS base
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.component_breakdown) = 'array' THEN l.component_breakdown ELSE '[]'::jsonb END) item
          LEFT JOIN payroll_components pc ON pc.id::text = item->>'componentId' AND pc.company_id = h.company_id
         WHERE (item->>'isUifApplicable')::boolean
           AND (pc.component_type = 'earning' OR item->>'componentId' LIKE 'synthetic:termination:%')
      ) u
      LEFT JOIN LATERAL (
        SELECT w->'etiMonth' AS parts
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.validation_results) = 'array' THEN l.validation_results ELSE '[]'::jsonb END) w
         WHERE w->>'code' = ${ETI_MONTH_PENDING}
         LIMIT 1
      ) w ON true
     WHERE h.company_id = ${companyId}::uuid
       AND ${sql.unsafe(payRunFinalSql('h'))}
       AND h.pay_frequency = ${frequency}
       AND h.period_year = ${period.year}::int AND h.period_month = ${period.month}::int
       AND ${runIsBeforeSql('h', companyId, runId)}
       AND l.employee_id = ANY(${employeeIds}::uuid[])
     GROUP BY l.employee_id
  `) as DbRow[];
  const earlier = new Map(rows.map((r) => [String(r.employee_id), r]));
  return new Map(employeeIds.map((id) => {
    const r = earlier.get(id);
    const parts = ((r?.eti_parts ?? []) as unknown[]).map(partsOf);
    const cadence: LineCadence = {
      frequency, periodStart: period.start!, periodEnd: period.end!,
      uifMonthToDate: round2(Number(r?.uif_base ?? 0)),
      // A part that cannot be read makes the month's hours unknown (never a full month): no ETI is claimed on guesses.
      etiMonthToDate: closes
        ? parts.reduce<EtiMonthParts>((t, p) => addEtiMonthParts(t, p ?? { ...NO_ETI_PARTS, ordinaryHours: null }), NO_ETI_PARTS)
        : null,
    };
    return [id, cadence];
  }));
}
