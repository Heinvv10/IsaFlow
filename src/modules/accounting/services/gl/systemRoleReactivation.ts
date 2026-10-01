/**
 * The role guards of the chart's own write paths (updateAccount, deleteAccount,
 * the bank-accounts PUT), kept out of chartOfAccountsService.
 *
 * Reactivating a deactivated system account puts it back as a role holder. If
 * another account has taken that role since, the role would have two holders
 * and the resolver would choose between them — so the reactivation is refused,
 * naming the current holder. With the role empty the account holds the role
 * again — so it must pass the rule any account taking a role passes
 * (`roleTargetRules`): of a type the role allows, and not a balance-sheet
 * header with sub-accounts.
 *
 * Call under `lockSystemRoleWrites`, before any write of the request.
 */
import { sql } from '@/lib/neon';
import { SYSTEM_ACCOUNT_KEYS } from './systemAccountKeys';
import { boundedRowWait, lockSystemRoleWrites } from './systemRoleWriteLock';
import { ChartRefusal } from './chartRefusal';
import { roleBarringChildren, roleTargetRefusal } from './roleTargetRules';
import { assertRolesKept, snapshotRoles, type RoleSnapshot } from './systemRoleInvariant';
import { clearSystemAccountCacheAfterCommit } from './systemAccountResolver';

/** The refusal message, or null when reactivating `accountId` is safe. */
export async function reactivationRefusal(companyId: string, accountId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT a.account_code, a.account_type, a.account_subtype, a.is_system_account,
           (SELECT min(h.account_code) FROM gl_accounts h
             WHERE h.company_id = a.company_id AND h.account_subtype = a.account_subtype
               AND h.is_system_account IS TRUE AND h.is_active IS TRUE AND h.id <> a.id) AS holder_code,
           EXISTS (SELECT 1 FROM gl_accounts c
                    WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
    FROM gl_accounts a
    WHERE a.id::TEXT = ${accountId} AND a.company_id = ${companyId}::UUID
      -- IS [NOT] TRUE: both flags are nullable, and NOT NULL is NULL — a
      -- row with a NULL is_active is inactive to the resolver and must be checked.
      AND a.is_system_account IS TRUE AND a.is_active IS NOT TRUE
      AND a.account_subtype = ANY(${[...SYSTEM_ACCOUNT_KEYS]}::TEXT[])
  `) as { account_code: string; account_type: string; account_subtype: string; is_system_account: boolean;
    holder_code: string | null; has_children: boolean }[];
  const r = rows[0];
  if (!r) return null;
  if (r.holder_code) {
    return `Cannot reactivate system account ${r.account_code}: account ${r.holder_code} now holds the ${r.account_subtype} role. `
      + 'Reactivating it would give the role two holders; move the role in Default Accounts instead.';
  }
  // The role is empty: this account becomes its holder. Sub-accounts bar it
  // only where they bar a holder from gaining them (`roleBarringChildren`).
  return roleTargetRefusal(r.account_subtype, r.account_subtype, {
    code: r.account_code, type: r.account_type, isActive: true, subtype: r.account_subtype,
    hasChildren: r.has_children === true && roleBarringChildren(r) !== null,
  }, 'reactivate');
}

/**
 * What a guarded account write calls LAST, with its result: the post-condition
 * (`systemRoleInvariant` — every role held before is still held by exactly one
 * usable account) when the write could have changed a holder, then the
 * resolver-cache clear, which waits for the COMMIT. The cache carries the
 * holder's code and name too, so a rename clears it as well.
 */
export type FinishRoleWrite = <T>(result: T) => Promise<T>;

function finishWith(companyId: string, before: RoleSnapshot | null): FinishRoleWrite {
  return async (result) => {
    if (before) await assertRolesKept(companyId, before);
    clearSystemAccountCacheAfterCommit(companyId);
    return result;
  };
}

/**
 * `updateAccount`'s role guards, before its first read. A non-boolean flag is
 * refused (the guards test `=== true` / `=== false`; "true", 1 or [true] from
 * an unvalidated caller skipped them while Postgres still cast and applied
 * it). Then the role-write lock, for EVERY update whatever it changes: it is
 * the first lock any chart writer takes, so a row this request locks can never
 * be one a Default Accounts save — holding the role lock — is waiting for (an
 * MCP batch renamed the bank holder, then deactivated another account: 40P01).
 * Under it the caller's reads judge settled rows, and a reactivation that
 * would double a role is refused.
 */
export async function guardActiveChange(
  companyId: string, id: string, input: { isActive?: unknown; vatInputDenied?: unknown },
): Promise<FinishRoleWrite> {
  for (const flag of ['isActive', 'vatInputDenied'] as const) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw new ChartRefusal(`${flag} must be true or false`);
  }
  await lockSystemRoleWrites(companyId);
  if (input.isActive === undefined) return finishWith(companyId, null);
  const refusal = input.isActive === true ? await reactivationRefusal(companyId, id) : null;
  if (refusal) throw new ChartRefusal(refusal);
  return finishWith(companyId, await snapshotRoles(companyId));
}

/**
 * `deleteAccount`'s: under the role-write lock (a Default Accounts save may be
 * making this account a holder), a system account cannot go — posting resolves
 * its role to it.
 */
export async function refuseSystemAccountDelete(companyId: string, id: string): Promise<FinishRoleWrite> {
  await lockSystemRoleWrites(companyId);
  const [row] = (await sql`
    SELECT account_name FROM gl_accounts
    WHERE id::TEXT = ${id} AND company_id = ${companyId}::UUID AND is_system_account
  `) as { account_name: string }[];
  if (row) throw new ChartRefusal(`Cannot delete "${row.account_name}" — it is a system account`);
  return finishWith(companyId, await snapshotRoles(companyId));
}

export { boundedRowWait, ChartRefusal, clearSystemAccountCacheAfterCommit };

/** The role-write lock, first, for a chart write that changes no role (a code, a name, a bank field). */
export async function lockBeforeChartWrite(companyId: string): Promise<void> {
  await lockSystemRoleWrites(companyId);
}
