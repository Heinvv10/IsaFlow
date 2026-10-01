/**
 * A merge moves the source's sub-accounts under the target. Where the target
 * is a balance-sheet account that holds a system role, that would make the
 * holder a header (`roleTargetRules.roleBarringChildren`) — refused here, as a
 * merge refusal the caller can act on, before anything is written. The role
 * post-condition in `mergeAccounts` still stands behind it; without this guard
 * it was the only check, and its answer ("would leave receivable without
 * exactly one usable account", a 500 on a route) named nothing to fix.
 *
 * In its own file because accountMergeGuards is at the 300-line cap.
 */
import { AccountMergeError, type MergeAccount } from './accountMergeGuards';
import { hasChildAccounts } from './isReportVisibleLeaf';
import { holderAsParentRefusal, roleBarringChildren } from './roleTargetRules';

export async function assertTargetMayTakeChildren(
  companyId: string, source: MergeAccount, target: MergeAccount,
): Promise<void> {
  const role = roleBarringChildren({
    account_type: target.accountType, account_subtype: target.accountSubtype, is_system_account: target.isSystemAccount,
  });
  if (!role || !(await hasChildAccounts(companyId, source.id))) return;
  throw new AccountMergeError(
    `${source.accountCode} has sub-accounts, which this merge would move under ${target.accountCode}. `
    + `${holderAsParentRefusal(target.accountCode, role)} Or move ${source.accountCode}'s sub-accounts to another parent, then merge.`,
    'target_becomes_header',
  );
}
