/**
 * The console is never left without an active super admin (admin audit 2026-11-14, 3.3).
 *
 * Every change that can take a super admin out of the console (a role change or a suspension; deletion refuses
 * any super admin outright) calls `assertSuperAdminRemains` FIRST, inside the request transaction, before it
 * writes. It takes one transaction-scoped advisory lock for the whole roster, so two such changes serialise: the
 * second waits until the first COMMITs (or rolls back) and then counts what the first left. Without the lock two
 * concurrent demotions of the last two super admins each see the other still active, and both commit. The count
 * is a new statement after the lock, so it sees the first change only under READ COMMITTED: under a snapshot
 * isolation level it would judge a stale roster, so it refuses to judge (500).
 *
 * "Active" is `isActiveUserAccount` (src/lib/auth/userAccountStatus.ts), in SQL: what withPlatformAdmin admits.
 * A super admin acting on another super admin, or on themselves, stays allowed while another active one remains.
 */
import { sql } from '@/lib/neon';

export const LAST_SUPER_ADMIN_MESSAGE =
  'This is the last active super admin. Make someone else a super admin before removing this one.';

/** The 409's `details.reason`. Not a `readonly code` on the error: admin-only, never an MCP refusal (toolHelpers). */
export const LAST_SUPER_ADMIN_REASON = 'LAST_SUPER_ADMIN';

/** Refused before anything is written: the change would leave no active super admin. Answer 409. */
export class LastSuperAdminError extends Error {
  constructor() {
    super(LAST_SUPER_ADMIN_MESSAGE);
    this.name = 'LastSuperAdminError';
  }
}

export interface RosterTarget {
  role: string | null;
  /** The target is a super admin: the caller's audit row says so (`target_super_admin: true`). */
  isSuperAdmin: boolean;
}

/** Roster lock key; one lock for every super admin, so any two removals serialise. */
const ROSTER_LOCK = 'isaflow.admin.super_admin_roster';

/**
 * Locks the roster, then returns the target's role, or null when no such user exists. Throws LastSuperAdminError
 * when the change removes an active super admin and no OTHER active super admin exists (ids compared case-blind, so
 * a case-variant row of the same person is not "another"). `nextRole`: the role a PATCH sets; a change that keeps
 * `super_admin` (an unchanged role sent with other fields) removes nobody. Omitted (a suspension): it always removes.
 */
export async function assertSuperAdminRemains(userId: string, nextRole?: string): Promise<RosterTarget | null> {
  const [iso] = await sql<{ level: string }>`SELECT current_setting('transaction_isolation') AS level`;
  if (iso?.level !== 'read committed') {
    throw new Error(`super admin roster check needs READ COMMITTED, got ${iso?.level ?? 'unknown'}`);
  }
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${ROSTER_LOCK}, 0))`;
  const [target] = await sql<{ role: string | null; active: boolean }>`
    SELECT role,
           (is_active IS TRUE AND suspended_at IS NULL AND (status IS NULL OR lower(status) = 'active')) AS active
    FROM users WHERE id = ${userId} LIMIT 1
  `;
  if (!target) return null;
  const isSuperAdmin = target.role === 'super_admin';
  const removes = nextRole !== 'super_admin'; // undefined (a suspension) removes too
  if (isSuperAdmin && target.active && removes) {
    const [others] = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM users
      WHERE role = 'super_admin' AND lower(id) <> lower(${userId})
        AND is_active IS TRUE AND suspended_at IS NULL AND (status IS NULL OR lower(status) = 'active')
    `;
    if ((others?.n ?? 0) === 0) throw new LastSuperAdminError();
  }
  return { role: target.role, isSuperAdmin };
}
