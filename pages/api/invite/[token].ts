/**
 * GET  /api/invite/[token] — Validate an invitation token (public)
 * POST /api/invite/[token] — Accept an invitation (requires auth)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { serialize } from 'cookie';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

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

  const rows = (await sql`
    SELECT
      ci.email,
      ci.role,
      c.name AS company_name
    FROM company_invitations ci
    JOIN companies c ON c.id = ci.company_id
    WHERE ci.token = ${token}
      AND ci.accepted_at IS NULL
      AND ci.expires_at > NOW()
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) {
    return apiResponse.notFound(res, 'Invitation');
  }

  const row = rows[0];

  return apiResponse.success(res, {
    email: maskEmail(row.email as string),
    companyName: row.company_name as string,
    role: row.role as string,
  });
}

// ── POST: accept invitation (auth required) ───────────────────────────────────

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const authReq = req as AuthenticatedNextApiRequest;
  const { token } = req.query as { token: string };

  if (!token || typeof token !== 'string') {
    return apiResponse.badRequest(res, 'Token is required');
  }

  // Look up the invitation
  const rows = (await sql`
    SELECT id, company_id, email, role
    FROM company_invitations
    WHERE token = ${token}
      AND accepted_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) {
    return apiResponse.notFound(res, 'Invitation');
  }

  const inv = rows[0];
  const userId = authReq.user.id;

  // Verify invited email matches the logged-in user's email
  if ((inv.email as string).toLowerCase() !== authReq.user.email.toLowerCase()) {
    return apiResponse.forbidden(res, 'This invitation was sent to a different email address');
  }

  // Insert into company_users
  await sql`
    INSERT INTO company_users (company_id, user_id, role)
    VALUES (${inv.company_id}::UUID, ${userId}::UUID, ${inv.role})
    ON CONFLICT (company_id, user_id) DO NOTHING
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
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  res.setHeader('Set-Cookie', cookieStr);

  return apiResponse.success(res, { companyId: inv.company_id as string }, 'Invitation accepted');
}

// ── Router ────────────────────────────────────────────────────────────────────

const postHandler = withAuth(handlePost);

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
