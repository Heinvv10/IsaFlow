/**
 * GET  /api/auth/profile — returns current user's profile
 * PUT  /api/auth/profile — updates profile fields (email is read-only)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
type Row = Record<string, unknown>;

const PutBody = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  phone: z.string().optional(),
  mobile: z.string().optional(),
}).strict();


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

    const u = rows[0]!;
    return apiResponse.success(res, {
      id: String(u.id),
      email: String(u.email),
      firstName: u.first_name != null ? String(u.first_name) : '',
      lastName: u.last_name != null ? String(u.last_name) : '',
      phone: u.phone != null ? String(u.phone) : '',
      mobile: u.mobile != null ? String(u.mobile) : '',
      role: String(u.role),
      profilePicture: u.profile_picture != null ? String(u.profile_picture) : null,
    });
  }

  // ── PUT ──────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }

    const { firstName, lastName, phone, mobile } = parsed.data;

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

    const u = rows[0]!;
    log.info('Profile updated', { userId }, 'auth/profile');

    return apiResponse.success(res, {
      id: String(u.id),
      email: String(u.email),
      firstName: u.first_name != null ? String(u.first_name) : '',
      lastName: u.last_name != null ? String(u.last_name) : '',
      phone: u.phone != null ? String(u.phone) : '',
      mobile: u.mobile != null ? String(u.mobile) : '',
    }, 'Profile updated successfully');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(handler));
