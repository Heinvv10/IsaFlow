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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
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
  if (strength.score < 2) {
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

    log.info('User registered', { userId: String(user.id), email: user.email }, 'auth/register');

    return apiResponse.created(res, { userId: String(user.id), email: user.email });
  } catch (err) {
    log.error('Registration error', err instanceof Error ? { message: err.message } : { err }, 'auth/register');
    return apiResponse.internalError(res, err);
  }
}

export default withErrorHandler(handler as any);
