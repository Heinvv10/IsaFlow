/**
 * The audit row for a write that FILLS an empty bank role (a deactivated system bank account reactivated, a template
 * seed or a Sage commit that creates the holder). With `payroll_net_pay` unset payroll credits net pay to the bank-role
 * holder, so whoever gives the role a holder decides where net pay goes: the same record a Default Accounts save or a
 * CoA import writes (`auditDefaultAccountChanges`, key `primary_bank`, old = none), in the writer's own transaction.
 *
 * One helper for every such path: take the holder BEFORE the write, call `auditBankRoleFilled` after it. It writes
 * nothing when the role already had a holder (that is a move, which the Default Accounts / import paths record) or
 * still has none.
 */
import { sql, type TxSql } from '@/lib/neon';
import { auditDefaultAccountChanges } from './defaultAccountsAudit';
import { snapshotRoles } from './systemRoleInvariant';

/** The account id the resolver would hand out for the bank role now, or null. */
export async function bankRoleHolderId(companyId: string, q: TxSql = sql): Promise<string | null> {
  return (await snapshotRoles(companyId, q)).holders.get('bank') ?? null;
}

/** Audits `before === null` -> the holder it has now, if any. `userId` must be a real user (audit_log.user_id references users). */
export async function auditBankRoleFilled(companyId: string, userId: string, before: string | null, q: TxSql = sql): Promise<void> {
  if (before !== null) return;
  const now = await bankRoleHolderId(companyId, q);
  if (now === null) return;
  await auditDefaultAccountChanges(q, companyId, userId, [{ key: 'primary_bank', fromId: null, toId: now }]);
}
