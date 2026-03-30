/**
 * POST /api/auth/register
 * Creates a new user account with email + password.
 * Does NOT set an auth cookie — user must log in after registering.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { hashPassword, checkPasswordStrength } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  // Rate limit: 3 registrations per IP per 15 minutes
  const rawIp = Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
  const ip: string = rawIp ?? 'unknown';
  if (checkRateLimit(ip, { windowMs: 15 * 60 * 1000, maxRequests: 3 })) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
    });
  }

  const { firstName, lastName, email, password, confirmPassword } = req.body as {
    firstName?: string;
    lastName?: string;
    email?: string;
    password?: string;
    confirmPassword?: string;
  };

  // Validate all fields present
  if (!firstName || !lastName || !email || !password || !confirmPassword) {
    return apiResponse.badRequest(res, 'All fields are required');
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return apiResponse.badRequest(res, 'Please enter a valid email address');
  }

  // Validate passwords match
  if (password !== confirmPassword) {
    return apiResponse.badRequest(res, 'Passwords do not match');
  }

  // Check password strength
  const strength = checkPasswordStrength(password);
  if (!strength.isValid) {
    return apiResponse.badRequest(res, `Password too weak: ${strength.issues[0] || 'Please choose a stronger password'}`);
  }

  try {
    // Check email uniqueness
    const existing = (await sql`
      SELECT id FROM users WHERE LOWER(email) = LOWER(${email.trim()}) LIMIT 1
    `) as Row[];

    if (existing.length > 0) {
      return apiResponse.badRequest(res, 'An account with this email already exists');
    }

    // Hash password
    const hash = await hashPassword(password);

    // Insert user
    const rows = (await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, role, permissions, is_active, onboarding_completed)
      VALUES (${email.toLowerCase().trim()}, ${hash}, ${firstName.trim()}, ${lastName.trim()}, 'viewer', '[]', true, false)
      RETURNING id, email
    `) as Row[];

    const user = rows[0];
    const userId = String(user.id);
    const normalizedEmail = (email as string).toLowerCase().trim();

    // Auto-accept any pending company invitations for this email
    const pendingInvitations = (await sql`
      SELECT id, company_id, role
      FROM company_invitations
      WHERE LOWER(email) = LOWER(${normalizedEmail})
        AND accepted_at IS NULL
        AND expires_at > NOW()
    `) as Row[];

    let invitationsAccepted = 0;
    for (const inv of pendingInvitations) {
      await sql`
        INSERT INTO company_users (company_id, user_id, role, is_default)
        VALUES (${inv.company_id as string}::UUID, ${userId}::UUID, ${inv.role as string}, false)
        ON CONFLICT (company_id, user_id) DO NOTHING
      `;
      await sql`
        UPDATE company_invitations SET accepted_at = NOW() WHERE id = ${inv.id as string}::UUID
      `;
      invitationsAccepted++;
    }

    if (invitationsAccepted > 0) {
      await sql`UPDATE users SET onboarding_completed = true WHERE id = ${userId}`;
      log.info('Onboarding skipped via invitation acceptance at registration', { userId, invitationsAccepted }, 'auth/register');
    }

    log.info('User registered', { userId, email: user.email as string, invitationsAccepted }, 'auth/register');

    return apiResponse.created(res, { userId, email: user.email as string, invitationsAccepted });
  } catch (err) {
    log.error('Registration error', err instanceof Error ? { message: err.message } : { err }, 'auth/register');
    return apiResponse.internalError(res, err);
  }
}

export default withErrorHandler(handler as any);
