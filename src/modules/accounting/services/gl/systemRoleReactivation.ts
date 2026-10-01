/**
 * The role guards of the chart's own write paths (updateAccount, deleteAccount,
 * the bank-accounts PUT), kept out of chartOfAccountsService.
 *
 * Reactivating a deactivated system account puts it back as a role holder. If
 * another account has taken that role since, the role would have two holders
 * and the resolver would choose between them — so the reactivation is refused,
 * naming the current holder. With the role empty it is allowed: the account
 * simply holds the role again.
 *
 * Call under `lockSystemRoleWrites`, before any write of the request.
 */
import { sql } from '@/lib/neon';
import { SYSTEM_ACCOUNT_KEYS } from './systemAccountKeys';
import { lockSystemRoleWrites } from './systemRoleWriteLock';

/** The refusal message, or null when reactivating `accountId` is safe. */
export async function reactivationRefusal(companyId: string, accountId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT a.account_code, a.account_subtype, h.account_code AS holder_code
    FROM gl_accounts a
    JOIN gl_accounts h ON h.company_id = a.company_id AND h.account_subtype = a.account_subtype
      AND h.is_system_account AND h.is_active AND h.id <> a.id
    WHERE a.id::TEXT = ${accountId} AND a.company_id = ${companyId}::UUID
      AND a.is_system_account AND NOT a.is_active
      AND a.account_subtype = ANY(${[...SYSTEM_ACCOUNT_KEYS]}::TEXT[])
    ORDER BY h.account_code
    LIMIT 1
  `) as { account_code: string; account_subtype: string; holder_code: string }[];
  const r = rows[0];
  if (!r) return null;
  return `Cannot reactivate system account ${r.account_code}: account ${r.holder_code} now holds the ${r.account_subtype} role. `
    + 'Reactivating it would give the role two holders; move the role in Default Accounts instead.';
}

/**
 * `updateAccount`'s role guards, before its first read. A non-boolean flag is
 * refused (the guards test `=== true` / `=== false`; "true", 1 or [true] from
 * an unvalidated caller skipped them while Postgres still cast and applied
 * it). Any `is_active` change then takes the role-write lock — deactivating
 * could empty a role, reactivating could double one — so the caller's reads
 * judge settled rows, and a reactivation that would double a role is refused.
 */
export async function guardActiveChange(
  companyId: string, id: string, input: { isActive?: unknown; vatInputDenied?: unknown },
): Promise<void> {
  for (const flag of ['isActive', 'vatInputDenied'] as const) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw new Error(`${flag} must be true or false`);
  }
  if (input.isActive === undefined) return;
  await lockSystemRoleWrites(companyId);
  const refusal = input.isActive === true ? await reactivationRefusal(companyId, id) : null;
  if (refusal) throw new Error(refusal);
}

/**
 * `deleteAccount`'s: under the role-write lock (a Default Accounts save may be
 * making this account a holder), a system account cannot go — posting resolves
 * its role to it.
 */
export async function refuseSystemAccountDelete(companyId: string, id: string): Promise<void> {
  await lockSystemRoleWrites(companyId);
  const [row] = (await sql`
    SELECT account_name FROM gl_accounts
    WHERE id::TEXT = ${id} AND company_id = ${companyId}::UUID AND is_system_account
  `) as { account_name: string }[];
  if (row) throw new Error(`Cannot delete "${row.account_name}" — it is a system account`);
}
