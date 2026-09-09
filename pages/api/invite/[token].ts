/**
 * GET  /api/invite/[token] — Validate an invitation token (public)
 * POST /api/invite/[token] — Accept an invitation (requires auth)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import { withUserAuth, type AuthenticatedNextApiRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { serialize } from 'cookie';
type Row = Record<string, unknown>;

/**
 * POST body for accepting an invite. The action is fully determined by the
 * URL token and the authenticated user's session — no extra payload is needed.
 * We still parse and reject unexpected keys to prevent prototype-pollution / confusion.
 */
const PostBody = z.object({}).strict();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}


function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  return `${local[0]}***@${domain}`;
}

// ── GET: public token validation ──────────────────────────────────────────────

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { token } = req.query as { token: string };

  if (!token || typeof token !== 'string') {
    return apiResponse.badRequest(res, 'Token is required');
  }

  const tokenHash = hashToken(token);

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
    email: maskEmail(row.email as string),
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

  // Look up the invitation using the hashed token
  const tokenHash = hashToken(token);
  const rows = (await sql`
    SELECT id, company_id, email, role
    FROM company_invitations
    WHERE token = ${tokenHash}
      AND accepted_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) {
    return apiResponse.notFound(res, 'Invitation');
  }

  const inv = rows[0]!;
  const userId = authReq.user.id;

  // Verify invited email matches the logged-in user's email
  if ((inv.email as string).toLowerCase() !== (authReq.user.email ?? '').toLowerCase()) {
    return apiResponse.forbidden(res, 'This invitation was sent to a different email address');
  }

  // Insert into company_users.
  // DO UPDATE, not DO NOTHING: POST /api/invitations rewrites `role` on the
  // invitation row when the same address is re-invited, so an existing member
  // kept their old role while the invitation claimed the new one. Same fix as
  // pages/api/invitations/[token]/accept.ts — both routes accept the same rows.
  await sql`
    INSERT INTO company_users (company_id, user_id, role)
    VALUES (${inv.company_id}::UUID, ${userId}::UUID, ${inv.role})
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `;

  // Mark invitation accepted
  await sql`
    UPDATE company_invitations SET accepted_at = NOW() WHERE id = ${inv.id}::UUID
  `;

  // Mark onboarding completed for this user (they're joining an existing company)
  await sql`
    UPDATE users SET onboarding_completed = true WHERE id = ${userId}
  `;

  log.info('Invitation accepted via token page', { token, userId, companyId: inv.company_id }, 'invite');

  // Set the onboarding-done cookie so middleware stops redirecting
  const cookieStr = serialize('ff_onboarding_done', '1', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  res.setHeader('Set-Cookie', cookieStr);

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
