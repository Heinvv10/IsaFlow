import { isSystemAccountKey } from '@/modules/accounting/services/gl/systemAccountKeys';
import { roleBarringChildren } from '@/modules/accounting/services/gl/roleTargetRules';
import type { GLAccount } from '@/modules/accounting/types/gl.types';

/** What the lock on a system account means: for a role holder, which role, and where to change it. */
export function systemAccountNote(subtype: string | null | undefined): string {
  return isSystemAccountKey(subtype)
    ? `System account — holds the ${subtype.replace(/_/g, ' ')} role; change it in Default Accounts`
    : 'System account — it cannot be deleted or deactivated here';
}

/** May this account be offered as a parent? Not a balance-sheet role holder (the bank, receivable, payable…): the server refuses it. */
export const mayBeParent = (a: GLAccount): boolean =>
  !roleBarringChildren({ account_type: a.accountType, account_subtype: a.accountSubtype, is_system_account: a.isSystemAccount });
