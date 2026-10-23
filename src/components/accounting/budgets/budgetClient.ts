/** Shapes and labels the budgets page reads from /api/accounting/budgets. */

export interface BudgetMonth { month: string; amount: number }

export interface BudgetRow {
  id: string | null; glAccountId: string; accountCode: string; accountName: string;
  accountType: string; fiscalYear: number; annualAmount: number; months: BudgetMonth[]; notes?: string;
}

/** A financial year a budget can be set for; `monthKeys` are its 'YYYY-MM' months in order. */
export interface BudgetYear {
  fiscalYear: number; startDate: string; endDate: string; kind: string; monthKeys: string[];
}

export interface GLAccount { id: string; accountCode: string; accountName: string }

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

/** 'Mar 2026' for '2026-03'. */
export function monthLabel(key: string): string {
  return `${MONTH_LABELS[Number(key.slice(5, 7)) - 1] ?? key.slice(5, 7)} ${key.slice(0, 4)}`;
}

/** 'Jan 2026 - Feb 2027 (14 months)': the year's date range, as its months. */
export function yearRangeLabel(year: BudgetYear): string {
  const keys = year.monthKeys;
  if (keys.length === 0) return `${year.startDate} - ${year.endDate}`;
  return `${monthLabel(keys[0]!)} - ${monthLabel(keys[keys.length - 1]!)} (${keys.length} months)`;
}

/** The option text of the year select: the label with its range. */
export function yearOptionLabel(year: BudgetYear): string {
  return year.monthKeys.length > 0 ? `${year.fiscalYear}: ${yearRangeLabel(year)}` : String(year.fiscalYear);
}
