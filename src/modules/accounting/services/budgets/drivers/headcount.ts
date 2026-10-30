/**
 * Headcount per month for the per_head driver (P4 decision 7, confirmed by Hein
 * 2026-10-29). Pure: the payroll reader passes ids, dates, status, centre and
 * the allocation split only (never names or pay).
 *
 * An employee is ONE head in month M when startDate <= last day of M AND
 * (endDate null OR endDate >= first day of M) AND status !== 'inactive'. Any
 * day employed counts a full head (no pro-rata). Company scope (null): each
 * such employee is 1. Cost-centre scope: with allocation rows, Σ percentage/100
 * of that centre's rows; without, 1 when the employee's own centre matches. A
 * NULL centre counts only in company scope. Planned hires add their FTE when
 * startMonth <= M <= endMonth (open end = null). Dates compare as strings.
 */
import { round2 } from '@/modules/accounting/services/core/budgetMonths';

export interface HeadcountEmployee {
  id: string;
  /** 'YYYY-MM-DD' */
  startDate: string;
  /** 'YYYY-MM-DD' or null (still employed). */
  endDate: string | null;
  status: string;
  costCentreId: string | null;
}

export interface HeadcountAllocation {
  employeeId: string;
  costCentreId: string;
  /** 0..100 */
  percentage: number;
}

export interface PlannedHire {
  costCentreId: string | null;
  /** 'YYYY-MM' */
  startMonth: string;
  /** 'YYYY-MM' or null (open-ended). */
  endMonth: string | null;
  fte: number;
}

export interface HeadcountInput {
  employees: readonly HeadcountEmployee[];
  allocations: readonly HeadcountAllocation[];
  hires: readonly PlannedHire[];
  months: readonly string[];
  /** Cost centre id; null = company. */
  scope: string | null;
}

export interface MonthHeadcount {
  payroll: number;
  hires: number;
  total: number;
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function checked(value: string, shape: RegExp, what: string): string {
  if (!shape.test(value)) throw new RangeError(`Bad ${what}: ${JSON.stringify(value)}`);
  return value;
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** 'YYYY-MM' → 'YYYY-MM-DD' of its last day (February by the Gregorian leap rule). */
export function lastDayOf(month: string): string {
  checked(month, MONTH, 'month');
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const days = m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return `${month}-${String(days)}`;
}

function employedIn(e: HeadcountEmployee, first: string, last: string): boolean {
  if (e.status === 'inactive') return false;
  return e.startDate <= last && (e.endDate === null || e.endDate >= first);
}

/** Each employee's share of one head at the scope (1 at company scope). */
function sharesAt(input: HeadcountInput): Map<string, number> {
  const { scope } = input;
  const split = new Map<string, number>();
  const hasAllocation = new Set<string>();
  for (const a of input.allocations) {
    if (!Number.isFinite(a.percentage) || a.percentage < 0 || a.percentage > 100) {
      throw new RangeError(`Bad allocation percentage ${a.percentage} for ${a.employeeId} (0..100)`);
    }
    hasAllocation.add(a.employeeId);
    if (a.costCentreId === scope) split.set(a.employeeId, (split.get(a.employeeId) ?? 0) + a.percentage / 100);
  }
  const shares = new Map<string, number>();
  for (const e of input.employees) {
    if (scope === null) shares.set(e.id, 1);
    else if (hasAllocation.has(e.id)) shares.set(e.id, split.get(e.id) ?? 0);
    else shares.set(e.id, e.costCentreId === scope ? 1 : 0);
  }
  return shares;
}

export function headcountByMonth(input: HeadcountInput): Map<string, MonthHeadcount> {
  for (const e of input.employees) {
    checked(e.startDate, DATE, `start date for ${e.id}`);
    if (e.endDate !== null && checked(e.endDate, DATE, `end date for ${e.id}`) < e.startDate) {
      throw new RangeError(`End date ${e.endDate} is before start date ${e.startDate} for ${e.id}`);
    }
  }
  for (const h of input.hires) {
    checked(h.startMonth, MONTH, 'hire start month');
    if (h.endMonth !== null) checked(h.endMonth, MONTH, 'hire end month');
    if (!Number.isFinite(h.fte) || h.fte <= 0) throw new RangeError(`Bad hire FTE: ${h.fte}`);
  }
  const shares = sharesAt(input);
  const out = new Map<string, MonthHeadcount>();
  for (const month of input.months) {
    const first = `${checked(month, MONTH, 'month')}-01`;
    const last = lastDayOf(month);
    let payroll = 0;
    for (const e of input.employees) {
      if (employedIn(e, first, last)) payroll += shares.get(e.id) ?? 0;
    }
    let hires = 0;
    for (const h of input.hires) {
      const inScope = input.scope === null || h.costCentreId === input.scope;
      if (inScope && h.startMonth <= month && (h.endMonth === null || h.endMonth >= month)) hires += h.fte;
    }
    const p = round2(payroll);
    const hh = round2(hires);
    out.set(month, { payroll: p, hires: hh, total: round2(p + hh) });
  }
  return out;
}
