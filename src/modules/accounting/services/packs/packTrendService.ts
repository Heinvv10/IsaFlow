/**
 * The pack's twelve-month revenue / expense / profit series.
 *
 * One definition, because the printed PDF fetches it over HTTP while the PPTX
 * exporter calls it in-process; two queries would be two chances to disagree
 * on a document and a deck that a reader compares side by side.
 *
 * Dates are built from local calendar parts, never through toISOString(): on
 * this UTC+2 host `new Date('2026-01-01').toISOString()` is the previous day,
 * which silently drops a month off the front of the series.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface PackTrendPoint {
  /** YYYY-MM */
  month: string;
  /** 'Mar 2026' */
  label: string;
  revenue: number;
  expenses: number;
  netProfit: number;
}

interface MonthSlot { month: string; label: string; from: string; to: string }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** The `months` calendar months ending with the month containing `to`. */
export function monthSlots(to: string, months: number): MonthSlot[] {
  const [yearPart, monthPart] = to.split('-');
  const endYear = Number(yearPart);
  const endMonth = Number(monthPart); // 1-12
  const count = Math.min(12, Math.max(1, months));

  return Array.from({ length: count }, (_, i) => {
    const offset = endMonth - 1 - (count - 1 - i);
    const year = endYear + Math.floor(offset / 12);
    const monthIndex = ((offset % 12) + 12) % 12;
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    return {
      month: `${year}-${pad(monthIndex + 1)}`,
      label: `${MONTH_NAMES[monthIndex]} ${year}`,
      from: `${year}-${pad(monthIndex + 1)}-01`,
      to: `${year}-${pad(monthIndex + 1)}-${pad(lastDay)}`,
    };
  });
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export async function getPackTrend(companyId: string, to: string, months = 12): Promise<PackTrendPoint[]> {
  const slots = monthSlots(to, months);
  const first = slots[0]!;
  const last = slots[slots.length - 1]!;

  const rows = (await sql`
    SELECT to_char(je.entry_date, 'YYYY-MM')                                                        AS month,
           COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expenses
    FROM   gl_journal_lines  jl
    JOIN   gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN   gl_accounts        ga ON ga.id = jl.gl_account_id
    WHERE  je.company_id = ${companyId}::UUID
      AND  jl.company_id = ${companyId}::UUID
      AND  ga.company_id = ${companyId}::UUID
      AND  je.status     = 'posted'
      AND  je.entry_date >= ${first.from}::date
      AND  je.entry_date <= ${last.to}::date
    GROUP  BY 1
  `) as Row[];

  const byMonth = new Map(rows.map((r) => [String(r.month), r]));

  const points = slots.map((slot) => {
    const row = byMonth.get(slot.month);
    const revenue = num(row?.revenue);
    const expenses = num(row?.expenses);
    return {
      month: slot.month,
      label: slot.label,
      revenue,
      expenses,
      // The only arithmetic in this workstream, and it is the definition of
      // the series itself, not a restatement of a service figure.
      netProfit: Math.round((revenue - expenses) * 100) / 100,
    };
  });

  log.info('getPackTrend', { companyId, to, months: points.length }, 'packs');
  return points;
}
