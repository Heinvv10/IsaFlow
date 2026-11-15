/**
 * GET  /api/invite/[token] — Validate an invitation token (public)
 * POST /api/invite/[token] — Accept an invitation (requires auth)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { sql } from '@/lib/neon';
import { hashInviteToken } from '@/lib/auth/inviteToken';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import { withUserAuth, type AuthenticatedNextApiRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { setActiveCompanyCookie, setOnboardingDoneCookie } from '@/lib/auth/cookies';
import { isLiveCompanyForUser } from '@/lib/auth/liveCompanies';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { maskInviteEmail } from '@/lib/auth/maskInviteEmail';
import { EMAIL_IN_USE_MESSAGE, upsertInviteeProfile } from '@/lib/auth/inviteeProfile';
type Row = Record<string, unknown>;

/**
 * POST body for accepting an invite. The action is fully determined by the
 * URL token and the authenticated user's session — no extra payload is needed.
 * We still parse and reject unexpected keys to prevent prototype-pollution / confusion.
 */
const PostBody = z.object({}).strict();


// ── GET: public token validation ──────────────────────────────────────────────

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { token } = req.query as { token: string };

  if (!token || typeof token !== 'string') {
    return apiResponse.badRequest(res, 'Token is required');
  }

  const tokenHash = hashInviteToken(token);

  const rows = (await sql`
    SELECT
      ci.email,
      ci.role,
      c.name AS company_name,
      COALESCE(u.first_name || ' ' || u.last_name, u.email) AS invited_by_name
    FROM company_invitations ci
    JOIN companies c ON c.id = ci.company_id
    LEFT JOIN users u ON u.id = ci.invited_by
    WHERE ci.token = ${tokenHash}
      AND ci.accepted_at IS NULL
      AND ci.expires_at > NOW()
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) {
    return apiResponse.notFound(res, 'Invitation');
  }

  const row = rows[0]!;

  return apiResponse.success(res, {
    email: maskInviteEmail(row.email as string),
    companyName: row.company_name as string,
    role: row.role as string,
    invitedBy: (row.invited_by_name as string) || 'Someone',
  });
}

// ── POST: accept invitation (auth required) ───────────────────────────────────

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const authReq = req as AuthenticatedNextApiRequest;
  const { token } = req.query as { token: string };

  if (!token || typeof token !== 'string') {
    return apiResponse.badRequest(res, 'Token is required');
  }

  // Validate body — no fields expected; reject unknown keys
  const bodyToParse = req.body && typeof req.body === 'object' ? req.body : {};
  const parsed = PostBody.safeParse(bodyToParse);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Unexpected fields in request body');
  }

  // Lookup and the three writes run in ONE transaction on the migration_admin
  // pool, as /api/invitations/[token]/accept does. The caller is not yet a
  // member of the company, so no app_user or app_service rule admits this
  // membership write (migration 916); the app pools must not be able to make
  // it from a request (S-07b).
  const tokenHash = hashInviteToken(token);
  // One canonical id for every write and read below (brk-1440 L1): the membership took
  // the ::UUID cast's canonical text while the users row took the raw sub, so a sub in
  // another spelling wrote a users row the membership did not name, and the FK refused
  // the COMMIT. Set from the cast once the transaction is open; a sub that is no UUID
  // fails it (22P02, a 500), as the membership cast did before.
  let userId = authReq.user.id;
  const client = await migrationAdminPool().connect();
  let opened = false;
  let unusable = false;
  let inv: Row;
  try {
    opened = true; // before BEGIN (R-176): a BEGIN that reached the server but failed is rolled back too
    await client.query('BEGIN');
    userId = (await client.query<{ id: string }>('SELECT $1::uuid::text AS id', [userId])).rows[0]!.id;
    // A plain read, no FOR UPDATE: the invitation row is locked LAST, by the UPDATE that marks it accepted below,
    // as /api/invitations/[token]/accept and an admin's deleteUser (which cancels it) take it. Locking it first
    // deadlocked (40P01) against both: they hold the membership and users rows when they reach the invitation.
    const rows = (await client.query(
      `SELECT id, company_id, email, role
         FROM company_invitations
        WHERE token = $1
          AND accepted_at IS NULL
          AND expires_at > NOW()
        LIMIT 1`,
      [tokenHash],
    )).rows as Row[];

    if (rows.length === 0) {
      unusable = await rollbackFailed(client, 'invite accept');
      opened = false;
      return apiResponse.notFound(res, 'Invitation');
    }
    inv = rows[0]!;

    // Verify invited email matches the logged-in user's email
    if ((inv.email as string).toLowerCase() !== (authReq.user.email ?? '').toLowerCase()) {
      unusable = await rollbackFailed(client, 'invite accept');
      opened = false;
      return apiResponse.forbidden(res, 'This invitation was sent to a different email address');
    }

    // Insert into company_users.
    // DO UPDATE, not DO NOTHING: POST /api/invitations rewrites `role` on the
    // invitation row when the same address is re-invited, so an existing member
    // kept their old role while the invitation claimed the new one. Same fix as
    // pages/api/invitations/[token]/accept.ts — both routes accept the same rows.
    // Never an owner's role (886's company_member_role_is_owner, the guards' own
    // test, so `Owner ` too): an admin may invite any address at a lesser role, the
    // owner's own included, and accepting that demoted the company's last owner
    // (PR #691 review round 5). The invitation is still accepted.
    await client.query(
      `INSERT INTO company_users (company_id, user_id, role)
       VALUES ($1::UUID, $2::UUID, $3)
       ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role
         WHERE public.company_member_role_is_owner(company_users.role) IS NOT TRUE`,
      [inv.company_id, userId, inv.role],
    );

    // The profile row, after the membership (lock order), in this transaction: a signed-in
    // user may have no users row yet (signed up, never provisioned), and
    // company_users_user_id_fkey (996/997) refuses the membership at COMMIT without one.
    // Shared with /api/invitations/[token]/accept (inviteeProfile.ts).
    const profile = await upsertInviteeProfile(client, {
      userId, email: inv.email as string, firstName: null, lastName: null,
    });
    if (profile === 'email_in_use') {
      // 23505 aborted the transaction: roll back first. The membership INSERT above goes with it.
      unusable = await rollbackFailed(client, 'invite accept');
      opened = false;
      log.error('invite accept blocked: email already held by another user row', {
        inviteId: inv.id,
        companyId: inv.company_id,
      }, 'invite');
      return apiResponse.conflict(res, EMAIL_IN_USE_MESSAGE);
    }

    // Mark it accepted, still pending under its token, or nothing commits: a cancel (an admin deleting the user,
    // a revoke), a re-send or a competing accept since the read above leaves no row to mark, and the membership
    // and users row written above roll back with it.
    const marked = await client.query(
      `UPDATE company_invitations SET accepted_at = NOW()
        WHERE id = $1::UUID AND token = $2 AND accepted_at IS NULL AND expires_at > NOW()`,
      [inv.id, tokenHash],
    );
    if (marked.rowCount !== 1) {
      unusable = await rollbackFailed(client, 'invite accept');
      opened = false;
      return apiResponse.notFound(res, 'Invitation');
    }

    // Mark onboarding completed for this user (they're joining an existing company)
    await client.query(`UPDATE users SET onboarding_completed = true WHERE id = $1`, [userId]);
    await client.query('COMMIT');
    opened = false;
  } catch (err) {
    if (opened) unusable = await rollbackFailed(client, 'invite accept');
    throw err;
  } finally {
    client.release(unusable);
  }

  // The invitation id, not the raw token: src/lib/auth/inviteToken.ts exists so
  // the secret never leaves the request, and a log line is exactly where it must
  // not land.
  log.info('Invitation accepted via token page', { inviteId: inv.id, userId, companyId: inv.company_id }, 'invite');

  // As /api/invitations/<t>/accept: land in the company just joined, and past
  // the onboarding redirect, unless that company is no longer live (an
  // invitation can outlive it); then the session keeps its current company.
  if (await isLiveCompanyForUser(userId, inv.company_id as string)) {
    setActiveCompanyCookie(res, inv.company_id as string);
    setOnboardingDoneCookie(res);
  }

  return apiResponse.success(res, { companyId: inv.company_id as string }, 'Invitation accepted');
}

// ── Router ────────────────────────────────────────────────────────────────────

const postHandler = withUserAuth(withCsrf(handlePost));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }
    if (req.method === 'POST') {
      return await postHandler(req, res);
    }
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET', 'POST']);
  } catch (err) {
    log.error('Invite token handler error', err instanceof Error ? { message: err.message } : { err }, 'invite');
    return apiResponse.internalError(res, err);
  }
}
