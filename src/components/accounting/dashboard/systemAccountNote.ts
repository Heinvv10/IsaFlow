import { isSystemAccountKey } from '@/modules/accounting/services/gl/systemAccountKeys';

/** What the lock on a system account means: for a role holder, which role, and where to change it. */
export function systemAccountNote(subtype: string | null | undefined): string {
  return isSystemAccountKey(subtype)
    ? `System account — holds the ${subtype.replace(/_/g, ' ')} role; change it in Default Accounts`
    : 'System account — it cannot be deleted or deactivated here';
}
