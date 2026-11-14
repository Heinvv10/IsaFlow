// src/lib/auth/loginAsLookup.ts
// The capped Login-as session look-up shared by the two unauthenticated end paths: Sign Out (/api/auth/logout) and
// end-impersonation's refused Return (STASH_EXPIRED). #1371 security review / re-break M1.
import { createHash } from 'node:crypto';
import { impersonationPartiesOfBounded } from './impersonationSessions';
import { log } from '@/lib/logger';
import type { LoginAsParties } from './loginAsRecord';

/**
 * At most this many look-ups run at once, process-wide, across both paths: they are reachable without a live
 * session and not rate limited, so without a cap a burst could hold every platform_admin slot. Both callers take a
 * slot only after the stash row their cookie names was found and lists the token's user as a party (round 3 M1b),
 * so junk stash cookies, and sessions of users who hold no stash, never take one. One session id holds at most ONE
 * slot at a time. Each look-up is itself bounded (impersonationPartiesOfBounded: 1 s for a slot, 2 s statement).
 * Residual, accepted: only parties to a real stash (its admin, or its Login-as target) can take a slot, and several
 * of their valid sessions at once can still fill both, each for at most one bounded look-up; a Login-as end skipped
 * meanwhile revokes the caller's own session and leaves its stash row, unusable without the cleared cookie, to
 * expire within 1 h (purged by the next Login-as start or end).
 */
export const LOGIN_AS_LOOKUP_SLOTS = 2;
let inFlight = 0;
const sessionsInFlight = new Set<string>();

/** A short, non-reversible tag for a session id in logs. */
export const sessionTag = (sessionId: string): string => createHash('sha256').update(sessionId).digest('hex').slice(0, 12);

/**
 * The parties of the Login-as session `sessionId` (the caller verified the token it came from), or null for an
 * ordinary session. `skipped`: over the global or the per-session cap; `gave_up`: the look-up failed or passed its
 * bound. Both are logged at warn with the session tag; the caller ends nothing and carries on.
 */
export async function cappedLoginAsLookup(sessionId: string, source: string): Promise<LoginAsParties | null | 'skipped' | 'gave_up'> {
  if (inFlight >= LOGIN_AS_LOOKUP_SLOTS || sessionsInFlight.has(sessionId)) {
    log.warn(`${source}: Login-as look-up skipped (concurrency cap)`,
      { session: sessionTag(sessionId), perSession: sessionsInFlight.has(sessionId) }, 'Auth');
    return 'skipped';
  }
  inFlight += 1;
  sessionsInFlight.add(sessionId);
  try {
    return await impersonationPartiesOfBounded(sessionId);
  } catch (err) {
    log.warn(`${source}: Login-as session record look-up failed or timed out`,
      { session: sessionTag(sessionId), message: err instanceof Error ? err.message : String(err) }, 'Auth');
    return 'gave_up';
  } finally {
    inFlight -= 1;
    sessionsInFlight.delete(sessionId);
  }
}
