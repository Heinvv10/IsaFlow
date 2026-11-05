/**
 * Net pay's bank account for the payroll journal plan (payrollJournalBuilder).
 * Split out of payrollJournalParts.ts to keep both files near the 300-line cap.
 */
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { resolveAccountsById, type ResolvedAccount } from './payrollJournalParts';
import type { PayrollJournalPlanLine } from './payrollJournalBuilder';

export const MISSING_BANK_ACCOUNT = 'missing_bank_account';

/**
 * The account net pay is credited to: whichever account holds the company's
 * BANK system role, as `getSystemAccount` answers it for every other
 * auto-posting. The plan resolves it ONCE and the poster writes the plan's
 * account id, so the dry run and the live post cannot disagree.
 *
 * It used to be the literal code '1110'. Velocity Fibre deactivated 1110 and
 * moved the role to 1544331 on 2026-10-27, after which the run could never be
 * approved. With no holder this returns a blocker and never falls back to
 * 1110: a deactivated 1110, or an unrelated account that happens to carry the
 * code, is not the company's bank.
 *
 * `isActive` is read from the row, not the resolver's cache (up to a minute
 * old), so a holder deactivated since reads as the `inactive_target_account`
 * blocker rather than a posting the ledger then refuses. Only a missing role
 * is caught; any other failure is a crash and propagates.
 */
export async function resolveBankAccount(
  companyId: string,
): Promise<{ account: (ResolvedAccount & { code: string }) | null; blocker: { code: string; detail: string } | null }> {
  try {
    const holder = await getSystemAccount('bank', companyId);
    const row = (await resolveAccountsById(companyId, [holder.id])).get(holder.id);
    if (row) return { account: row, blocker: null };
  } catch (err) {
    if (!(err instanceof MissingSystemAccountError)) throw err;
    const near = err.nearMisses.length > 0
      ? ` Candidates already in the chart: ${err.nearMisses
        .map((c) => `${c.accountCode} ${c.accountName} (${c.isActive ? 'active' : 'deactivated'}, ${c.isSystemAccount ? 'system' : 'not a system account'})`)
        .join('; ')}.`
      : '';
    return { account: null, blocker: { code: MISSING_BANK_ACCOUNT, detail: bankBlockerDetail(err.remedy + near) } };
  }
  return { account: null, blocker: { code: MISSING_BANK_ACCOUNT, detail: bankBlockerDetail('The account that held the role no longer exists.') } };
}

/** Net pay's credit line. With no usable holder it carries no account (the plan is blocked) and never 1110. */
export function bankNetPayLine(account: Awaited<ReturnType<typeof resolveBankAccount>>['account'], net: number): PayrollJournalPlanLine {
  return {
    glAccountId: account?.id ?? null,
    accountCode: account?.code ?? '',
    accountName: account?.name ?? '',
    debit: 0,
    credit: net,
    description: 'Net pay — bank disbursement',
    inactiveAccount: account ? !account.isActive : false,
    cc1Id: null,
  };
}

const bankBlockerDetail = (why: string): string =>
  `No active account holds the company's bank role, so net pay has no account to be credited. ${why} `
  + 'Set the bank account in Default Accounts; the journal never falls back to account 1110.';
