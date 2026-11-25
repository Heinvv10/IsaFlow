/**
 * What a payslip calls its pay period (wave 7 PP, RS1). A monthly regular run is its calendar month; a weekly or
 * fortnightly run is its own date range (the run's period_start..period_end), never the calendar month it falls in;
 * an off-cycle run says what it is ("Bonus, Nov 2026"). The one label the PDF, the email subject and the portal list use.
 * Pure text: the PDF test and the email test read it without a database.
 */
import { formatDayRange, formatMonth } from './payrollPayWeek';

export interface PeriodFacts {
  periodMonth: number;
  periodYear: number;
  /** The run's own dates; null on a monthly run (it carries none, payrollFrequency.runPeriodOf). */
  periodStart: string | null;
  periodEnd: string | null;
  payFrequency: string;
  runKind: string;
  offCycleReason: string | null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The calendar month in words: 'November 2026'. */
export const monthName = (f: Pick<PeriodFacts, 'periodMonth' | 'periodYear'>): string => `${MONTHS[f.periodMonth - 1]} ${f.periodYear}`;

const REASON_WORDS: Record<string, string> = { bonus: 'Bonus', termination: 'Termination' };

/** 'Week 22–28 Feb 2027', 'Fortnight 8–21 Feb 2027', 'Bonus, Nov 2026', 'November 2026'. */
export function payslipPeriodTitle(f: PeriodFacts): string {
  if (f.runKind === 'off_cycle') return `${REASON_WORDS[f.offCycleReason ?? ''] ?? 'Off-cycle'}, ${formatMonth(f.periodYear, f.periodMonth)}`;
  const word = f.payFrequency === 'weekly' ? 'Week' : f.payFrequency === 'fortnightly' ? 'Fortnight' : null;
  if (word && f.periodStart && f.periodEnd) return `${word} ${formatDayRange(f.periodStart, f.periodEnd)}`;
  return monthName(f);
}

/** The part of a slip's file name that tells its runs apart: the month, else the period's first day, else month-reason. */
export function payslipPeriodToken(f: PeriodFacts): string {
  const ym = `${f.periodYear}-${String(f.periodMonth).padStart(2, '0')}`;
  if (f.runKind === 'off_cycle') return `${ym}-${String(f.offCycleReason ?? 'offcycle').replace(/[^a-z]/g, '') || 'offcycle'}`;
  if ((f.payFrequency === 'weekly' || f.payFrequency === 'fortnightly') && f.periodStart) return f.periodStart;
  return ym;
}
