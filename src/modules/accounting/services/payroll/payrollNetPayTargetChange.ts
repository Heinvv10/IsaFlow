/**
 * The approval gate's refusal for a reopened run whose journal is still in
 * force when net pay's TARGET changed since it posted (the `payroll_net_pay`
 * setting was switched on, off, or moved to another account).
 *
 * Re-locking onto that journal would keep net pay on the old target while the
 * setting says otherwise: a bank journal kept after the company allocates its
 * salary bank lines to 2170 counts net pay twice. The journal must be reversed
 * so approving posts the new one. Split out of payrollApprovalGate to keep it
 * under the 300-line cap.
 */
import type { PayrollJournalNote } from './payrollJournalBuilder';
import {
  NET_PAY_CLEARING_DESCRIPTION, NET_PAY_DESCRIPTION, netPayTargetChanged,
  type FigureLine, type PostedFigureLine,
} from './payrollLabourComparison';

type PlanLine = FigureLine & { description: string; accountCode: string; accountName: string };

const NET_PAY = new Set([NET_PAY_DESCRIPTION, NET_PAY_CLEARING_DESCRIPTION]);
const where = (kind: string, name: string | undefined): string =>
  kind === NET_PAY_DESCRIPTION ? `the bank${name ? ` (${name})` : ''}` : `the net-pay clearing account${name ? ` (${name})` : ''}`;

/**
 * `postedNames[i]` is "code name" of `posted[i]`'s account (the journal's own lines, index for index).
 * Null when net pay's target did not change.
 */
export function netPayTargetChangeNote(
  plan: PlanLine[], posted: PostedFigureLine[], postedNames: string[], entryNumber: string,
): PayrollJournalNote | null {
  if (!netPayTargetChanged(plan, posted)) return null;
  const now = plan.find((l) => NET_PAY.has(l.description) && l.credit > 0);
  const index = posted.findIndex((l) => l.description !== null && NET_PAY.has(l.description) && l.credit > 0);
  const named = (code: string, name: string): string | undefined => (code ? `${code} ${name}`.trim() : undefined);
  return {
    code: 'net_pay_target_changed',
    detail: `This run's net pay was posted to ${where(posted[index]!.description!, postedNames[index])}, but the Payroll net pay `
      + `setting now sends it to ${where(now!.description, named(now!.accountCode, now!.accountName))}. `
      + `Reverse journal ${entryNumber} first; approving then posts a new one to the account now set.`,
  };
}
