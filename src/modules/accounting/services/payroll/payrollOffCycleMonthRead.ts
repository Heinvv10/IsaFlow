/**
 * The month's earlier final lines of each employee on an off-cycle run (wave 6 OC; the rules are payrollOffCycleMonth.ts):
 * the lines of this company's FINAL runs (payRunFinalSql) of the same pay month and frequency that come before this
 * run in pay order (runOrderKeySql: the regular run first, then earlier off-cycle runs). Their stored UIF and ETI, and
 * the earnings they paid, rebuilt from the stored breakdown as the line costed them (the month's ETI base, hours and
 * wage): an item is an earning when its component is one (joined by id within the company) or it is a termination
 * pay-out (synthetic:termination:*). Scoped by company_id throughout.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { runOrderKeySql } from './payrollRunOrder';
import type { MonthEarlierLines } from './payrollOffCycleMonth';
import type { ComponentBreakdownItem, EmployeeComponent } from './payrollTypes';

const n = (v: unknown): number => Number(v) || 0;

/** The earnings a stored breakdown paid, as components (only what the ETI base, hours and wage read). */
export function earningsOfBreakdown(items: Array<ComponentBreakdownItem & { isEarning?: boolean }>): EmployeeComponent[] {
  return items.filter((i) => i.isEarning === true).map((i) => ({
    component: {
      id: i.componentId, name: i.componentName, sarsSourceCode: i.sarsSourceCode, componentType: 'earning' as const,
      isTaxable: i.isTaxable, isUifApplicable: i.isUifApplicable, isSdlApplicable: i.isSdlApplicable === true,
    },
    amount: Number(i.amount) || 0,
    ...(i.isNonCash ? { isNonCash: true } : {}),
    ...(i.payeInclusionRate !== undefined ? { payeInclusionRate: i.payeInclusionRate } : {}),
    ...(i.quantity !== undefined ? { quantity: i.quantity, quantityUnit: i.quantityUnit ?? null } : {}),
  }));
}

export async function loadMonthEarlierLines(companyId: string, runId: string, employeeIds: string[]): Promise<Map<string, MonthEarlierLines>> {
  if (employeeIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT l.employee_id, l.uif_employee, l.uif_employer, l.eti,
           COALESCE((
             SELECT jsonb_agg(item || jsonb_build_object('isEarning',
                      pc.component_type = 'earning' OR item->>'componentId' LIKE 'synthetic:termination:%'))
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
    const had = out.get(id) ?? { uifEmployee: 0, uifEmployer: 0, eti: 0, etiComponents: [] };
    out.set(id, {
      uifEmployee: had.uifEmployee + n(r.uif_employee),
      uifEmployer: had.uifEmployer + n(r.uif_employer),
      eti: had.eti + n(r.eti),
      etiComponents: [...had.etiComponents, ...earningsOfBreakdown((r.items ?? []) as Array<ComponentBreakdownItem & { isEarning?: boolean }>)],
    });
  }
  return out;
}
