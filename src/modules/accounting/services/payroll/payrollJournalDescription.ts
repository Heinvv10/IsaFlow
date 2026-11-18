/**
 * The description a pay run's journal carries. One definition: the journal plan sets it (payrollJournalBuilder), the
 * salary bank file binds its anchor journal to the run by it (payrollBankFileJudge), and the reversal guard finds the
 * run of an unlinked journal by it (payrollJournalReversalGuard).
 *
 *  - A monthly regular run: "Payroll run 2026-10" (unchanged since before wave 6; one such run a month).
 *  - Any other run (wave 6 FQc; carried from review #1507, item 2): "Payroll run 2026-10 <kind>, paid 2026-10-24", where
 *    <kind> is the run's frequency (weekly, fortnightly) for a regular run and its off-cycle reason (bonus,
 *    termination) for an off-cycle run, and the date is its pay date (run_date, else period_end: payrollRunOrder's key
 *    2). A month holds several such runs, so the month alone cannot name one. OC adopts this string for off-cycle runs;
 *    FQc chose it (coordinator, 2026-11-17).
 */
import { dateColumnOf, payFrequencyOf } from './payrollFrequency';

export function payrollRunJournalDescription(periodYear: number, periodMonth: number): string {
  return `Payroll run ${periodYear}-${String(periodMonth).padStart(2, '0')}`;
}

/** The kinds a run-keyed description names. */
export const RUN_JOURNAL_KINDS = ['weekly', 'fortnightly', 'bonus', 'termination'] as const;
export type RunJournalKind = (typeof RUN_JOURNAL_KINDS)[number];

/** A run-keyed description: its month, kind and pay date. Matches nothing but runJournalDescriptionOf's output. */
export const RUN_KEYED_JOURNAL = /^Payroll run (\d{4})-(\d{2}) (weekly|fortnightly|bonus|termination), paid (\d{4}-\d{2}-\d{2})$/;

/** The description for a payroll_run_headers row (SELECT * shape). */
export function runJournalDescriptionOf(row: Record<string, unknown>): string {
  const month = payrollRunJournalDescription(Number(row.period_year), Number(row.period_month));
  const frequency = payFrequencyOf(row.pay_frequency);
  const offCycle = row.run_kind === 'off_cycle';
  if (!offCycle && frequency === 'monthly') return month;
  const kind = offCycle ? String(row.off_cycle_reason) : frequency;
  if (!(RUN_JOURNAL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`runJournalDescriptionOf: a run of kind ${kind} has no journal description`);
  }
  const payDate = dateColumnOf(row.run_date) ?? dateColumnOf(row.period_end);
  if (!payDate) throw new Error('runJournalDescriptionOf: the run has neither a pay date nor a period end');
  return `${month} ${kind}, paid ${payDate}`;
}
