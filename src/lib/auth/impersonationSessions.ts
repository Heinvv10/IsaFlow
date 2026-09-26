/**
 * Which GoTrue sessions are platform-admin impersonations (R-032).
 *
 * "Login as" gives the admin a genuine session for the target, so the request
 * itself cannot say who is acting, and the proof/stash cookies that mark it can
 * be deleted by the admin's own browser. The minted session's `session_id` is
 * recorded server-side instead (migration 709) — never reused, unchanged by
 * refresh, never deleted — and a control that must know who is really acting
 * asks `currentSessionActor()`.
 */
import { sql } from '@/lib/neon';
import { getPlatformAdminPool } from './withPlatformAdmin.pools';

/**
 * Must run before any target cookie is issued: if it throws, the impersonation
 * must not start.
 *
 * Written on its OWN autocommit connection, not the request transaction:
 * withPlatformAdmin COMMITs only after the handler returns and does not hold
 * the response, so a row written inside it is invisible to the approve route
 * when the cookies go out, and is lost if that transaction then rolls back. A
 * row committed here and orphaned by a later rollback only over-refuses.
 */
export async function registerImpersonationSession(input: {
  sessionId: string; actorUserId: string; targetUserId: string;
}): Promise<void> {
  await getPlatformAdminPool().query(
    `INSERT INTO impersonation_sessions (session_id, actor_user_id, target_user_id) VALUES ($1, $2, $3)`,
    [input.sessionId, input.actorUserId, input.targetUserId],
  );
}

/**
 * `unknown`: the request transaction carries no session id, so an impersonation
 * cannot be ruled out. Every GoTrue session has one; callers treat `unknown` as
 * a refusal rather than guess.
 */
export type SessionActor = 'self' | 'impersonation' | 'unknown';

/**
 * Reads the session the request transaction is authenticated as — withAuth's
 * `request.jwt.claims` — not anything a caller passes in.
 */
export async function currentSessionActor(): Promise<SessionActor> {
  const rows = await sql<{ session_id: string | null; impersonated: boolean }>`
    SELECT c.session_id,
           EXISTS (SELECT 1 FROM impersonation_sessions s WHERE s.session_id = c.session_id) AS impersonated
    FROM (SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id' AS session_id) c
  `;
  const row = rows[0];
  if (!row?.session_id) return 'unknown';
  return row.impersonated ? 'impersonation' : 'self';
}
