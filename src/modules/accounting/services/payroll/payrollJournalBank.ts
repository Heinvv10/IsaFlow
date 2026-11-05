/**
 * Net pay's bank account for the payroll journal plan (payrollJournalBuilder).
 * Split out of payrollJournalParts.ts to keep both files near the 300-line cap.
 *
 * The account is whichever one holds the company's BANK system role, resolved
 * by `gl/bankRoleHolder` (the same answer the UIF, directive and loan payments
 * get). The plan resolves it ONCE and the poster writes the plan's account id,
 * so the dry run and the live post cannot disagree.
 *
 * It used to be the literal code '1110'. Velocity Fibre deactivated 1110 and
 * moved the role to 1544331 on 2026-10-27, after which the run could never be
 * approved. With no usable holder this returns a blocker and never falls back
 * to 1110: a deactivated 1110, or an unrelated account that happens to carry
 * the code, is not the company's bank. A holder deactivated since the resolver
 * cached it reads as the `inactive_target_account` blocker (the builder).
 */
import { resolveBankRoleHolder, type BankRoleHolder } from '@/modules/accounting/services/gl/bankRoleHolder';
import { NET_PAY_DESCRIPTION } from './payrollLabourComparison';
import type { PayrollJournalPlanLine } from './payrollJournalBuilder';

export async function resolveBankAccount(
  companyId: string,
): Promise<{ account: BankRoleHolder | null; blocker: { code: string; detail: string } | null }> {
  const { account, refusal } = await resolveBankRoleHolder(companyId);
  return { account, blocker: refusal };
}

/** Net pay's credit line. With no usable holder it carries no account (the plan is blocked) and never 1110. */
export function bankNetPayLine(account: BankRoleHolder | null, net: number): PayrollJournalPlanLine {
  return {
    glAccountId: account?.id ?? null,
    accountCode: account?.code ?? '',
    accountName: account?.name ?? '',
    debit: 0,
    credit: net,
    description: NET_PAY_DESCRIPTION,
    inactiveAccount: account ? !account.isActive : false,
    cc1Id: null,
  };
}
