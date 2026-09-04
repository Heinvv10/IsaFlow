/**
 * System role coverage: which of the 14 roles this company can actually resolve,
 * and for the ones it cannot, what is standing next to the gap.
 *
 * Replaces `validateSystemAccounts`, which returned bare strings for 9 of the
 * 14 roles and could not tell "no such account exists" from "the account exists
 * and one boolean is wrong". Those are different findings with different
 * remedies: creating a second bank account for a company whose real bank is
 * merely unflagged makes the chart worse, not better.
 *
 * The set of roles checked is `SYSTEM_ACCOUNT_KEYS` itself, so a role added to
 * the type is checked here without anyone remembering to add it.
 *
 * ONE QUERY, unfiltered on is_active and is_system_account, and both of those
 * are the point — the near-miss classification is exactly the rows the
 * resolver's cache excludes.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import {
  SYSTEM_ACCOUNT_KEYS,
  type NearMissClaimant,
  type SystemAccountKey,
  type SystemRoleGap,
} from './systemAccountKeys';

/** A role that resolves, a role that is ambiguous, or a role that is empty. */
export type SystemRoleState = 'ok' | 'contested' | 'empty';

export interface SystemRoleCoverage {
  key: SystemAccountKey;
  state: SystemRoleState;
  /** Set only when `state` is 'empty' — what shape the gap has. */
  gap?: SystemRoleGap;
  /** Set when the role resolves: the account the resolver would hand out. */
  holder?: NearMissClaimant;
  /**
   * Every account carrying this subtype, in any state. For an 'empty' role
   * these are the near misses; for a 'contested' one they are the rival
   * claimants; for a clean 'ok' role there is exactly one.
   */
  claimants: NearMissClaimant[];
}

export interface SystemRoleCoverageReport {
  roles: SystemRoleCoverage[];
  /** Roles the resolver cannot serve — every auto-posting path needing one throws. */
  empty: SystemRoleCoverage[];
  /** Roles more than one active system account claims; the resolver picks one. */
  contested: SystemRoleCoverage[];
}

function toClaimant(r: DbRow): NearMissClaimant {
  return {
    accountCode: String(r.account_code ?? ''),
    accountName: String(r.account_name ?? ''),
    accountType: String(r.account_type ?? ''),
    isActive: r.is_active === true,
    isSystemAccount: r.is_system_account === true,
  };
}

/**
 * Classify a role from every account carrying its subtype.
 *
 * Gap precedence when a role is empty: an ACTIVE but unflagged claimant beats a
 * deactivated system one. Brightsphere had both — two deactivated
 * "Bank - Primary"/"Current Account" system rows with zero transactions between
 * them, beside `1049686 Brighttech Absa` holding 8,342 bank transactions and no
 * system flag. Reactivating the empty stub would have pointed every future
 * auto-posting at an account with no history; flagging the account that already
 * holds the history is the fix. So the remedy that names the real account wins.
 */
export function classifyRole(key: SystemAccountKey, claimants: NearMissClaimant[]): SystemRoleCoverage {
  const resolvable = claimants.filter((c) => c.isActive && c.isSystemAccount);
  if (resolvable.length === 1) {
    return { key, state: 'ok', holder: resolvable[0], claimants };
  }
  if (resolvable.length > 1) {
    return { key, state: 'contested', holder: resolvable[0], claimants };
  }

  let gap: SystemRoleGap = 'no_claimant';
  if (claimants.some((c) => c.isActive && !c.isSystemAccount)) {
    gap = 'unflagged_active_claimant';
  } else if (claimants.some((c) => c.isSystemAccount && !c.isActive)) {
    gap = 'deactivated_claimants_only';
  }
  return { key, state: 'empty', gap, claimants };
}

/**
 * Coverage for every role, for one company.
 *
 * Scoped by `company_id` in the WHERE clause; the subtype list is bound as a
 * single array parameter rather than interpolated.
 */
export async function getSystemRoleCoverage(companyId: string): Promise<SystemRoleCoverageReport> {
  const rows = (await sql`
    SELECT account_code, account_name, account_type, account_subtype,
           is_active, is_system_account
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID
      AND account_subtype = ANY(${[...SYSTEM_ACCOUNT_KEYS]}::TEXT[])
    ORDER BY account_code
  `) as DbRow[];

  const bySubtype = new Map<string, NearMissClaimant[]>();
  for (const r of rows) {
    const subtype = String(r.account_subtype ?? '');
    const list = bySubtype.get(subtype);
    if (list) list.push(toClaimant(r));
    else bySubtype.set(subtype, [toClaimant(r)]);
  }

  const roles = SYSTEM_ACCOUNT_KEYS.map((key) => classifyRole(key, bySubtype.get(key) ?? []));

  return {
    roles,
    empty: roles.filter((r) => r.state === 'empty'),
    contested: roles.filter((r) => r.state === 'contested'),
  };
}

/**
 * The near misses for ONE role, for the error a failed resolution throws.
 *
 * A separate query rather than a slice of the full report, because this runs on
 * the throw path only: the resolver has already established the role is empty
 * and is assembling the refusal. Paying for the whole chart there would tax
 * every successful call to serve the rare failing one.
 */
export async function describeEmptyRole(
  key: SystemAccountKey,
  companyId: string,
): Promise<{ gap: SystemRoleGap; nearMisses: NearMissClaimant[] }> {
  const rows = (await sql`
    SELECT account_code, account_name, account_type, is_active, is_system_account
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID
      AND account_subtype = ${key}
    ORDER BY account_code
  `) as DbRow[];

  const claimants = rows.map(toClaimant);
  const classified = classifyRole(key, claimants);
  // `classifyRole` can only come back 'ok'/'contested' here if the chart changed
  // between the resolver's cached read and this one. Report it as no_claimant
  // rather than inventing a gap shape — the refusal itself is still correct,
  // and the next call will resolve cleanly off a fresh cache.
  return { gap: classified.gap ?? 'no_claimant', nearMisses: claimants };
}
