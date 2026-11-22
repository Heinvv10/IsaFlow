/**
 * The month's earlier final lines of each employee on an off-cycle run (wave 6 OC; the rules are payrollOffCycleMonth.ts):
 * the lines of this company's FINAL runs (payRunFinalSql) of the same pay month and frequency that come before this
 * run in pay order (runOrderKeySql: the regular run first, then earlier off-cycle runs). Their stored ETI, and the
 * earnings they paid, rebuilt from the stored breakdown as the line costed them: an item is an earning when its
 * component is one (joined by id within the company) or it is a termination pay-out (synthetic:termination:*). From
 * those earnings: the month's ETI base, hours and wage, and the UIF remuneration (the UIF-applicable ones at their PAYE
 * share where they carry one, exactly as payrollRunCadence reads a weekly run's month to date). The UIF those lines
 * booked is their STORED contributions (review #1679 codex 1), not a rebuild. A line that paid but rebuilds no earning
 * (an imported line with an empty breakdown) is counted in unrebuiltPay: the ETI cannot be costed on it (review of
 * 99db78312, payrollOffCycleMonth.offCycleEtiRefusal) and keeps its class as stored (storedClass). Scoped by company_id throughout.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { runOrderKeySql } from './payrollRunOrder';
import { ONCE_OFF_MARKER_VERSION } from './payrollCalculationVersion';
import { strongestStoredClass, type MonthEarlierLines, type StoredClass } from './payrollOffCycleMonth';
import type { ComponentBreakdownItem, EmployeeComponent } from './payrollTypes';

const n = (v: unknown): number => Number(v) || 0;
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The UIF remuneration a stored breakdown levied on: its UIF-applicable earnings, at their PAYE share where stored. */
export function uifRemunerationOf(items: Array<ComponentBreakdownItem & { isEarning?: boolean }>): number {
  return items.filter((i) => i.isEarning === true && i.isUifApplicable === true)
    .reduce((t, i) => t + n(i.payeIncludedAmount ?? i.amount), 0);
}

/** The earnings a stored breakdown paid, as components (only what the ETI base, hours and wage read). */
export function earningsOfBreakdown(items: Array<ComponentBreakdownItem & { isEarning?: boolean }>): EmployeeComponent[] {
  return items.filter((i) => i.isEarning === true).map((i) => ({
    component: {
      id: i.componentId, name: i.componentName, sarsSourceCode: i.sarsSourceCode, componentType: 'earning' as const,
      isTaxable: i.isTaxable, isUifApplicable: i.isUifApplicable, isSdlApplicable: i.isSdlApplicable === true,
    },
    amount: Number(i.amount) || 0,
    ...(i.isNonCash ? { isNonCash: true } : {}),
    ...(i.onceOff ? { isRecurring: false } : {}), // a once-off is not time-worked pay (timeWorkedEarnings)
    ...(i.payeInclusionRate !== undefined ? { payeInclusionRate: i.payeInclusionRate } : {}),
    ...(i.quantity !== undefined ? { quantity: i.quantity, quantityUnit: i.quantityUnit ?? null } : {}),
  }));
}

export async function loadMonthEarlierLines(companyId: string, runId: string, employeeIds: string[]): Promise<Map<string, MonthEarlierLines>> {
  if (employeeIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT l.employee_id, l.gross_pay, l.eti, l.uif_employee, l.uif_employer,
           COALESCE(o.calculation_version, 0) < ${ONCE_OFF_MARKER_VERSION} AS historic,
           -- The line's class as stored (review L2 of f37f0f15a6): undetermined, a regular-pay directive (its PAYE
           -- explanation's directive steps), flat (PAYE outside the tables at 25%), else the tables.
           CASE WHEN COALESCE(l.validation_results @> '[{"code": "EMPLOYMENT_UNDETERMINED"}]'::jsonb, false) THEN 'undetermined'
                WHEN COALESCE(jsonb_path_exists(l.explanation, 'lax $.paye.**.key ? (@ starts with "paye.regularDirective")'), false) THEN 'directive'
                WHEN COALESCE(l.validation_results @> '[{"code": "PAYE_OUTSIDE_TABLES", "treatment": "flat_25"}]'::jsonb, false) THEN 'flat'
                ELSE 'tables' END AS stored_class,
           COALESCE((
             SELECT jsonb_agg(item || jsonb_build_object('isEarning',
                      pc.component_type = 'earning' OR item->>'componentId' LIKE 'synthetic:termination:%',
                      -- A line before the marker: the item's assignment, the one of its component and amount active over
                      -- the month (gate ruling 1); null when none or several match.
                      'assignmentRecurring', (
                        SELECT CASE WHEN count(*) = 1 THEN bool_and(ec.is_recurring) END
                          FROM payroll_employee_components ec
                         WHERE ec.employee_id = l.employee_id AND ec.component_id::text = item->>'componentId'
                           AND ec.amount = (item->>'amount')::numeric
                           AND ec.effective_from <= o.period_end AND (ec.effective_to IS NULL OR ec.effective_to >= o.period_start)
                           -- As it stood when the line was calculated (review L3): a row added since is not its assignment,
                           -- nor one superseded before it (L2 of e8a2d72dbc: a package apply had cut it, so it was not paid).
                           AND ec.created_at <= l.created_at
                           AND (ec.superseded_at IS NULL OR ec.superseded_at > l.created_at))))
               FROM jsonb_array_elements(l.component_breakdown) AS item
               LEFT JOIN payroll_components pc ON pc.id::text = item->>'componentId' AND pc.company_id = me.company_id
           ), '[]'::jsonb) AS items
      FROM payroll_run_headers me
      JOIN payroll_run_headers o
        ON o.company_id = me.company_id AND o.period_year = me.period_year AND o.period_month = me.period_month
       AND o.pay_frequency = me.pay_frequency AND o.id <> me.id
      JOIN payroll_run_lines l ON l.run_id = o.id
     WHERE me.id = ${runId}::uuid AND me.company_id = ${companyId}::uuid
       AND ${sql.unsafe(payRunFinalSql('o'))}
       AND ${runOrderKeySql('o')} < ${runOrderKeySql('me')}
       AND l.employee_id = ANY(${employeeIds}::uuid[])
  `) as DbRow[];
  const out = new Map<string, MonthEarlierLines>();
  for (const r of rows) {
    const id = String(r.employee_id);
    const raw = (r.items ?? []) as Array<ComponentBreakdownItem & { isEarning?: boolean; assignmentRecurring?: boolean | null }>;
    // A line before the onceOff marker (gate ruling 1 on e0eec1dea1): each unflagged basic pay item takes its
    // assignment's kind; one that cannot be recovered leaves the line's class as stored.
    let unrecovered = false;
    const items = r.historic !== true ? raw : raw.map((i) => {
      if (i.isEarning !== true || i.onceOff || i.sarsSourceCode?.trim() !== '3601') return i;
      if (i.assignmentRecurring === false) return { ...i, onceOff: true as const };
      if (i.assignmentRecurring !== true) unrecovered = true;
      return i;
    });
    const had = out.get(id) ?? { uifRemuneration: 0, eti: 0, etiComponents: [], uifEmployee: 0, uifEmployer: 0 };
    const earnings = earningsOfBreakdown(items);
    // A line that paid but rebuilds no earning (an import with an empty breakdown): its paid earnings cannot be
    // reclassified either, so its class as stored stands (review of fd9193cc2: a flat-25% month stays flat).
    if (earnings.length === 0 && n(r.gross_pay) > 0) unrecovered = true;
    out.set(id, {
      uifRemuneration: round2(had.uifRemuneration + uifRemunerationOf(items)),
      // What the earlier lines booked, as stored (review #1679 codex 1): an imported line's breakdown may be empty.
      uifEmployee: round2((had.uifEmployee ?? 0) + n(r.uif_employee)),
      uifEmployer: round2((had.uifEmployer ?? 0) + n(r.uif_employer)),
      eti: round2(had.eti + n(r.eti)),
      etiComponents: [...had.etiComponents, ...earnings],
      // A line that paid but whose breakdown rebuilds no earning (an import): the month's ETI base cannot be told.
      unrebuiltPay: round2((had.unrebuiltPay ?? 0) + (earnings.length === 0 ? Math.max(0, n(r.gross_pay)) : 0)),
      ...(unrecovered || had.storedClass ? { storedClass: strongestStoredClass(had.storedClass, unrecovered ? r.stored_class as StoredClass : undefined) } : {}),
    });
  }
  return out;
}
