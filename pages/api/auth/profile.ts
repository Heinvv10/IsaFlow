/**
 * GET  /api/auth/profile — returns current user's profile
 * PUT  /api/auth/profile — updates profile fields (email is read-only)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authReq = req as AuthenticatedNextApiRequest;
  const userId = authReq.user.id;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT id, email, first_name, last_name, phone, mobile, role, profile_picture
      FROM users
      WHERE id = ${userId}
      LIMIT 1
    `) as Row[];

    if (!rows.length) {
      return apiResponse.notFound(res, 'User');
    }

    const u = rows[0];
    return apiResponse.success(res, {
      id: u.id,
      email: u.email,
      firstName: u.first_name ?? '',
      lastName: u.last_name ?? '',
      phone: u.phone ?? '',
      mobile: u.mobile ?? '',
      role: u.role,
      profilePicture: u.profile_picture ?? null,
    });
  }

  // ── PUT ──────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const { firstName, lastName, phone, mobile } = req.body as {
      firstName?: string;
      lastName?: string;
      phone?: string;
      mobile?: string;
    };

    if (!firstName?.trim() || !lastName?.trim()) {
      return apiResponse.badRequest(res, 'First name and last name are required');
    }

    const rows = (await sql`
      UPDATE users
      SET
        first_name = ${firstName.trim()},
        last_name  = ${lastName.trim()},
        phone      = ${phone?.trim() ?? null},
        mobile     = ${mobile?.trim() ?? null}
      WHERE id = ${userId}
      RETURNING id, email, first_name, last_name, phone, mobile
    `) as Row[];

    const u = rows[0];
    log.info('Profile updated', { userId }, 'auth/profile');

    return apiResponse.success(res, {
      id: u.id,
      email: u.email,
      firstName: u.first_name ?? '',
      lastName: u.last_name ?? '',
      phone: u.phone ?? '',
      mobile: u.mobile ?? '',
    }, 'Profile updated successfully');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(handler as any) as any);
