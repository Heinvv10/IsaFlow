/**
 * The blockers that depend on the plan's finished lines (payrollJournalBuilder):
 * deactivated targets, an empty or negative journal, a closed period, an
 * unbalanced total. Split out of the builder to keep it under the 300-line cap.
 * Order is the poster's refusal order (it throws the first).
 */
import { closedPeriodBlocker } from './payrollJournalParts';
import type { PayrollJournalNote, PayrollJournalPlanLine } from './payrollJournalBuilder';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function judgeJournalLines(
  companyId: string,
  lines: PayrollJournalPlanLine[],
  entryDate: string,
): Promise<{ blockers: PayrollJournalNote[]; totalDebit: number; totalCredit: number }> {
  const blockers: PayrollJournalNote[] = [];

  const inactive = [...new Set(lines.filter((l) => l.inactiveAccount).map((l) => l.accountCode))];
  if (inactive.length > 0) {
    blockers.push({
      code: 'inactive_target_account',
      detail: `This journal posts into deactivated accounts: ${inactive.join(', ')}. The ledger refuses a posting to a deactivated account; reactivate them before posting.`,
    });
  }

  // The GL poster refuses both of these; saying so here lets the dry run and
  // approval refuse BEFORE anything is written, with the reason (K-079).
  if (lines.length === 0) {
    blockers.push({
      code: 'nothing_to_post',
      detail: 'The run has no amounts to post — every journal line is zero. Calculate the run first.',
    });
  }
  const negative = lines.filter((l) => l.debit < 0 || l.credit < 0);
  if (negative.length > 0) {
    // A line with no account (net pay with no bank holder) has no code: name it by its description.
    blockers.push({
      code: 'negative_amount',
      detail: `The run totals give a negative amount on ${negative.map((l) => l.accountCode || l.description).join(', ')}, which a journal line cannot carry. Check the run's totals.`,
    });
  }
  const closed = await closedPeriodBlocker(companyId, entryDate);
  if (closed) blockers.push(closed);

  const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
  // Exact to the cent, as the GL's validateJournalEntry is: a 1-cent tolerance
  // here let a plan pass that the live post then refused.
  if (Math.round((totalDebit - totalCredit) * 100) !== 0) {
    blockers.push({
      code: 'unbalanced',
      detail: `Payroll journal unbalanced by ${(totalDebit - totalCredit).toFixed(2)} (DR ${totalDebit.toFixed(2)} vs CR ${totalCredit.toFixed(2)}).`,
    });
  }
  return { blockers, totalDebit, totalCredit };
}
