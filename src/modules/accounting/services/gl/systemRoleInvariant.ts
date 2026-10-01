/**
 * The post-condition every writer of role holders ends on: each role that had
 * a holder before the write (or that the write moved) still resolves to
 * exactly the account intended — one active holder, not a second claimant
 * beside it, not a balance-sheet account the write has just turned into a
 * header with sub-accounts, and of a type the role allows (unless it was
 * already so before this write: existing charts have such holders, and this
 * check must not block every later write to them). A role that had NO holder
 * before and has one after is judged with no such allowance — the write made
 * that account a holder (a reactivation into an empty role put the role on a
 * header and on a mistyped account), so it must be a clean one.
 * The Default Accounts save has always ended on this; the other
 * writers each guarded the cases someone had thought of, and a role was still
 * emptied by the ones nobody had (a mapped import row that was skipped). This
 * is the check that does not depend on enumerating them.
 *
 * Take the `before` snapshot under `lockSystemRoleWrites`, on the writer's own
 * transaction, and check as the writer's last step.
 */
import { sql, type TxSql } from '@/lib/neon';
import { typeFitsSubtype, type SystemAccountKey } from './systemAccountKeys';
import { HOLDER_NO_CHILDREN_TYPES } from './roleTargetRules';
import { getSystemRoleCoverage } from './systemRoleCoverage';

export interface RoleSnapshot {
  /** Role → the account id systemAccountResolver would hand out (same winner rule). */
  holders: Map<SystemAccountKey, string>;
  /** Roles more than one active system account claims. */
  contested: Set<SystemAccountKey>;
  /** Holders that are headers they may not be: balance-sheet accounts with sub-accounts (`roleBarringChildren`). */
  headers: Set<string>;
  /** Role → its holder's account_type. */
  types: Map<SystemAccountKey, string>;
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
  const types = new Map<SystemAccountKey, string>();
  for (const role of coverage.roles) {
    if (!role.holder) continue;
    holders.set(role.key, role.holder.id);
    types.set(role.key, role.holder.accountType);
  }
  const parents = (await q`
    SELECT h.id::TEXT AS id FROM gl_accounts h
    WHERE h.company_id = ${companyId}::UUID AND h.id::TEXT = ANY(${[...holders.values()]}::TEXT[])
      AND h.account_type = ANY(${[...HOLDER_NO_CHILDREN_TYPES]}::TEXT[])
      AND EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_account_id = h.id AND c.company_id = h.company_id)
  `) as { id: string }[];
  return { holders, types, contested: new Set(coverage.contested.map((r) => r.key)), headers: new Set(parents.map((p) => p.id)) };
}

/** The roles `after` no longer holds as `before` (and `moved`: role → the account it was moved to) intended. */
export function rolesNotKept(
  before: RoleSnapshot, after: RoleSnapshot, moved: ReadonlyMap<SystemAccountKey, string> = new Map(),
): SystemAccountKey[] {
  const roles = new Set<SystemAccountKey>([...before.holders.keys(), ...moved.keys(), ...after.holders.keys()]);
  return [...roles].filter((role) => {
    // A role with no holder before the write is held by whatever the write put there.
    const intended = moved.get(role) ?? before.holders.get(role) ?? after.holders.get(role)!;
    // `placed`: this write put the role where it is — nothing about its holder is inherited.
    const placed = moved.has(role) || !before.holders.has(role);
    if (after.holders.get(role) !== intended) return true;
    // A role this write placed, or one that was cleanly held, must not be contested now.
    if (after.contested.has(role) && (placed || !before.contested.has(role))) return true;
    // Nor may its holder have become a barred header in this write (a placed role's holder may not be one at all).
    if (after.headers.has(intended) && (placed || !before.headers.has(intended))) return true;
    // Nor be of a type the role does not allow — newly so, or at all for a role this write placed.
    const fits = (types: RoleSnapshot['types']) => typeFitsSubtype(types.get(role) ?? '', role);
    return !fits(after.types) && (placed || fits(before.types));
  });
}

/** Throws SystemRoleInvariantError unless every role in `before` (and `moved`, and newly held) is kept. */
export async function assertRolesKept(
  companyId: string, before: RoleSnapshot, moved?: ReadonlyMap<SystemAccountKey, string>, q: TxSql = sql,
): Promise<void> {
  const wrong = rolesNotKept(before, await snapshotRoles(companyId, q), moved);
  if (wrong.length > 0) throw new SystemRoleInvariantError(wrong);
}
