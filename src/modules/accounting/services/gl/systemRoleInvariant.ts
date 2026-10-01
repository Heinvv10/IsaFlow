/**
 * The post-condition every writer of role holders ends on: each role that had
 * a holder before the write (or that the write moved) still resolves to
 * exactly the account intended — one active holder, not a second claimant
 * beside it, and not an account the write has just turned into a header with
 * sub-accounts. The Default Accounts save has always ended on this; the other
 * writers each guarded the cases someone had thought of, and a role was still
 * emptied by the ones nobody had (a mapped import row that was skipped). This
 * is the check that does not depend on enumerating them.
 *
 * Take the `before` snapshot under `lockSystemRoleWrites`, on the writer's own
 * transaction, and check as the writer's last step.
 */
import { sql, type TxSql } from '@/lib/neon';
import type { SystemAccountKey } from './systemAccountKeys';
import { getSystemRoleCoverage } from './systemRoleCoverage';

export interface RoleSnapshot {
  /** Role → the account id systemAccountResolver would hand out (same winner rule). */
  holders: Map<SystemAccountKey, string>;
  /** Roles more than one active system account claims. */
  contested: Set<SystemAccountKey>;
  /** Holders that are headers: they have sub-accounts. */
  headers: Set<string>;
}

/** A write left a role without exactly one usable holder. Nothing may be committed. */
export class SystemRoleInvariantError extends Error {
  readonly code = 'SYSTEM_ROLE_INVARIANT';
  constructor(readonly roles: readonly string[]) {
    super(`This change would leave ${roles.join(', ')} without exactly one usable account; `
      + 'posting would fail or use another account. Nothing was changed.');
    this.name = 'SystemRoleInvariantError';
  }
}

export async function snapshotRoles(companyId: string, q: TxSql = sql): Promise<RoleSnapshot> {
  const coverage = await getSystemRoleCoverage(companyId, q);
  const holders = new Map<SystemAccountKey, string>();
  for (const role of coverage.roles) if (role.holder) holders.set(role.key, role.holder.id);
  const parents = (await q`
    SELECT DISTINCT parent_account_id::TEXT AS id FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND parent_account_id::TEXT = ANY(${[...holders.values()]}::TEXT[])
  `) as { id: string }[];
  return { holders, contested: new Set(coverage.contested.map((r) => r.key)), headers: new Set(parents.map((p) => p.id)) };
}

/** The roles `after` no longer holds as `before` (and `moved`: role → the account it was moved to) intended. */
export function rolesNotKept(
  before: RoleSnapshot, after: RoleSnapshot, moved: ReadonlyMap<SystemAccountKey, string> = new Map(),
): SystemAccountKey[] {
  const roles = new Set<SystemAccountKey>([...before.holders.keys(), ...moved.keys()]);
  return [...roles].filter((role) => {
    const intended = moved.get(role) ?? before.holders.get(role)!;
    if (after.holders.get(role) !== intended) return true;
    // A role this write moved, or one that was cleanly held, must not be contested now.
    if (after.contested.has(role) && (moved.has(role) || !before.contested.has(role))) return true;
    // Nor may its holder have become a header in this write (a moved role's target may not be one at all).
    return after.headers.has(intended) && (moved.has(role) || !before.headers.has(intended));
  });
}

/** Throws SystemRoleInvariantError unless every role in `before` (and `moved`) is kept. */
export async function assertRolesKept(
  companyId: string, before: RoleSnapshot, moved?: ReadonlyMap<SystemAccountKey, string>, q: TxSql = sql,
): Promise<void> {
  const wrong = rolesNotKept(before, await snapshotRoles(companyId, q), moved);
  if (wrong.length > 0) throw new SystemRoleInvariantError(wrong);
}
