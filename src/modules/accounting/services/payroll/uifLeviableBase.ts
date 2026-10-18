/**
 * The UIF base of a payroll run line, for the UI-19 line view.
 *
 * `payroll_run_lines` stores the rounded contribution and the component
 * breakdown, not the leviable base itself. The base is rebuilt the way
 * payrollCalculator builds `uifLeviable`: the sum of the EARNING components
 * flagged UIF-applicable. The breakdown holds each component's amount and the
 * `isUifApplicable` flag as it stood in the run; its type is read from
 * payroll_components by id (termination components carry a synthetic id and are
 * all earnings). A reconstruction is only trusted when it reproduces the stored
 * contribution to the cent; otherwise (a component that cannot be resolved, a
 * missing or malformed breakdown, a UIF-excluded employee) the figure is
 * derived from the stored contribution alone, which is exact only at the
 * ceiling or when the whole gross was leviable and otherwise up to R0.50 out.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * The UIF ceiling in force for the periods this view serves, and 1% of it.
 * A named constant, not a tax-table lookup, so an old or future period does not
 * need a table to be displayed. Must equal `uifCeiling` in taxTables.ts
 * (tests pin that); revisit with a period-effective value when SARS moves it.
 */
export const UIF_MONTHLY_CEILING = 17_712;
export const UIF_CEILING_CONTRIBUTION = 177.12;

const SYNTHETIC_ID_PREFIX = 'synthetic:termination:';

export interface BreakdownItem {
  componentId: string;
  amount: number;
  isUifApplicable: boolean;
}

export interface UifLineBase {
  leviableSalary: number;
  isCapped: boolean;
  /** True when rebuilt from the components; false when derived from the stored contribution. */
  exact: boolean;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Same rounding as uifEngine.calculateUIF. */
function contributionOn(leviable: number): number {
  return Math.round(Math.min(leviable, UIF_MONTHLY_CEILING) * 0.01 * 100) / 100;
}

function isBreakdownItem(v: unknown): v is BreakdownItem {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o.componentId === 'string'
    && typeof o.amount === 'number' && typeof o.isUifApplicable === 'boolean';
}

/** The stored `component_breakdown` (parsed jsonb or text), or null if it is not usable. */
export function parseBreakdown(raw: unknown): BreakdownItem[] | null {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(isBreakdownItem)) return null;
  return value;
}

/** Shape only (Postgres accepts any hex 8-4-4-4-12), so seeded ids pass too. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids whose component type has to be looked up: UIF-applicable and a uuid. A
 * legacy or imported id that is neither a uuid nor synthetic would make the
 * `::uuid[]` cast throw for the whole declaration, so it is left out and stays
 * unresolved: that one line falls back.
 */
export function componentIdsToResolve(items: BreakdownItem[]): string[] {
  return items
    .filter((i) => i.isUifApplicable && UUID_SHAPE.test(i.componentId))
    .map((i) => i.componentId);
}

/** component_type per id, for the given ids, scoped to the company. */
export async function loadComponentTypes(
  companyId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id, component_type FROM payroll_components
    WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[])
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), String(r.component_type)]));
}

/** uifLeviable as payrollCalculator built it, or null when a component cannot be resolved. */
export function rebuildUifLeviable(
  items: BreakdownItem[],
  types: Map<string, string>,
): number | null {
  let leviable = 0;
  for (const item of items) {
    if (!item.isUifApplicable) continue;
    const type = item.componentId.startsWith(SYNTHETIC_ID_PREFIX)
      ? 'earning'
      : types.get(item.componentId);
    if (type === undefined) return null;
    if (type === 'earning') leviable += item.amount;
  }
  return leviable;
}

export function uifLineBase(
  grossPay: number,
  employeeContribution: number,
  rebuiltLeviable: number | null = null,
): UifLineBase {
  if (rebuiltLeviable !== null && contributionOn(rebuiltLeviable) === employeeContribution) {
    return {
      leviableSalary: r2(Math.min(rebuiltLeviable, UIF_MONTHLY_CEILING)),
      isCapped: rebuiltLeviable > UIF_MONTHLY_CEILING,
      exact: true,
    };
  }
  if (employeeContribution <= 0) return { leviableSalary: grossPay, isCapped: false, exact: false };
  // Capped = the contribution reached the ceiling's and gross is above the ceiling. Leviable pay in
  // (R17 711.50, R17 712] on a line above the ceiling through non-UIF earnings reads as capped here.
  if (employeeContribution >= UIF_CEILING_CONTRIBUTION && grossPay > UIF_MONTHLY_CEILING) {
    return { leviableSalary: UIF_MONTHLY_CEILING, isCapped: true, exact: false };
  }
  if (r2(grossPay * 0.01) === employeeContribution) {
    return { leviableSalary: grossPay, isCapped: false, exact: false };
  }
  return { leviableSalary: r2(employeeContribution / 0.01), isCapped: false, exact: false };
}
