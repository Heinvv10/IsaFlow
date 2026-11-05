/**
 * The approval gate's two notes about net pay's TARGET (the `payroll_net_pay` setting was switched on, off, or moved to
 * another account, or the bank role moved), split out of payrollApprovalGate to keep it under the 300-line cap:
 *
 *  - `net_pay_target_changed`, a REFUSAL, for a reopened run whose journal is still in force. Re-locking onto that
 *    journal would keep net pay on the old target while the setting says otherwise: a bank journal kept after the
 *    company allocates its salary bank lines to 2170 counts net pay twice.
 *  - `net_pay_target_replaced`, an ADVISORY (it blocks nothing), for a run whose journal was REVERSED and is now
 *    replaced by a fresh one. The fresh one credits today's setting; the salary cash was booked against the old
 *    journal's target and stays there, so the person must see both accounts before approving.
 *
 * A posted journal whose lines carry neither net-pay description (one from before the descriptions were written, or
 * a hand-keyed one) is not recognised by either note: against a clearing plan the gate then refuses it as
 * `recalculated_after_posting` (its accounts differ), which is safe (nothing re-locks) but names the wrong cause.
 */
import type { PayrollJournalNote } from './payrollJournalBuilder';
import {
  NET_PAY_CLEARING_DESCRIPTION, NET_PAY_DESCRIPTION, netPayTargetChanged,
  type FigureLine, type PostedFigureLine,
} from './payrollLabourComparison';

type PlanLine = FigureLine & { description: string; accountCode: string; accountName: string };
type NamedLine = { accountCode: string; accountName: string };

const NET_PAY = new Set([NET_PAY_DESCRIPTION, NET_PAY_CLEARING_DESCRIPTION]);
const where = (kind: string, name: string | undefined): string =>
  kind === NET_PAY_DESCRIPTION ? `the bank${name ? ` (${name})` : ''}` : `the net-pay clearing account${name ? ` (${name})` : ''}`;
const named = (code: string, name: string): string | undefined => (code ? `${code} ${name}`.trim() : undefined);
const isNetPayCredit = (l: { description: string | null; debit: number; credit: number }): boolean =>
  l.description !== null && NET_PAY.has(l.description) && l.credit > 0 && l.debit === 0;

/** The blocker codes of an unusable net-pay clearing account (payrollJournalBank#resolveClearingAccount, netPayTargetRules). */
const CLEARING_BLOCKER_CODES = new Set([
  'missing_net_pay_account', 'invalid_net_pay_setting', 'not_liability_net_pay_account', 'inactive_net_pay_account',
  'header_net_pay_account', 'net_pay_account_conflict', 'not_payroll_liability_net_pay_account', 'loan_net_pay_account',
]);

/**
 * For a journal in force: when the plan's clearing net-pay line has no account (the setting names an account that now
 * fails the rules), that is the plan's own blocker to show, not a "target changed" and not a mere figures difference.
 * Null when the clearing line resolved, or when there is none (a bank plan with no holder keeps re-locking: the bank
 * role is one role on both sides, payrollLabourComparison#foldNetPayBank).
 */
export function unresolvedNetPayBlocker(plan: PlanLine[], blockers: PayrollJournalNote[]): PayrollJournalNote | null {
  const unresolved = plan.some((l) => l.description === NET_PAY_CLEARING_DESCRIPTION && l.credit > 0 && l.glAccountId === null);
  return unresolved ? blockers.find((b) => CLEARING_BLOCKER_CODES.has(b.code)) ?? null : null;
}

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
  const was = where(posted[index]!.description!, postedNames[index]);
  const to = where(now!.description, named(now!.accountCode, now!.accountName));
  return {
    code: 'net_pay_target_changed',
    detail: `This run's net pay was posted to ${was} in journal ${entryNumber}, but the Payroll net pay setting now sends it to ${to}, `
      + 'so approving onto that journal is refused. Either set Payroll net pay in Default Accounts back and approve again, '
      + `or reverse journal ${entryNumber}: approving then posts a new journal to the account the setting names at that time (${to} today). `
      + `Reversing returns the net pay to the account it was posted to, but the cash that paid it stays booked there.`,
  };
}

/**
 * The advisory for a journal that REPLACES a reversed one (`replaces`), when the reversed journal's net-pay credit and
 * the plan's are on different accounts (bank and clearing, two clearing accounts, or a bank role that moved).
 * Empty when they agree, when either side has no single net-pay line, or when the plan has no account for it (blocked).
 */
export function netPayReplacementAdvisories(
  plan: PlanLine[], posted: PostedFigureLine[], replaced: { entryNumber: string; lines: NamedLine[] },
): PayrollJournalNote[] {
  const was = posted.flatMap((l, i) => (isNetPayCredit(l) ? [i] : []));
  const now = plan.filter((l) => isNetPayCredit(l));
  if (was.length !== 1 || now.length !== 1 || now[0]!.glAccountId === null) return [];
  const old = posted[was[0]!]!;
  if (old.glAccountId === now[0]!.glAccountId) return [];
  const oldLine = replaced.lines[was[0]!]!;
  const from = where(old.description!, named(oldLine.accountCode, oldLine.accountName));
  const to = where(now[0]!.description, named(now[0]!.accountCode, now[0]!.accountName));
  return [{
    code: 'net_pay_target_replaced',
    detail: `The journal this run is replacing (${replaced.entryNumber}) credited net pay to ${from}, but the Payroll net pay setting now `
      + `sends it to ${to}, so the new journal credits ${to}. The cash leg of ${replaced.entryNumber} stays where it was: the salary `
      + `payments already made are booked against ${from} and nothing moves them. Check that they are allocated to the account the new `
      + `journal credits; otherwise net pay is counted twice (or not at all) between the two accounts. To pay from ${from} again, `
      + 'set Payroll net pay in Default Accounts back before approving.',
  }];
}
