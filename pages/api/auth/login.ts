/**
 * POST /api/auth/login
 * Authenticates a user with email + password.
 * On success: signs a JWT, creates a DB session, sets an HttpOnly cookie.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { serialize } from 'cookie';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import { verifyPassword } from '@/lib/auth/password';
import { signToken } from '@/lib/auth/jwt';
import { createSession } from '@/lib/auth/session';
import { AUTH_COOKIE_NAME } from '@/lib/auth/middleware';
import type { AuthRole } from '@/lib/auth/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    return apiResponse.badRequest(res, 'Email and password are required');
  }

  try {
    // Look up user by email
    const rows = (await sql`
      SELECT id, email, password_hash, first_name, last_name, role,
             is_active, permissions, profile_picture, department, onboarding_completed
      FROM users
      WHERE email = ${email.toLowerCase().trim()}
      LIMIT 1
    `) as Row[];

    const user = rows[0];

    if (!user) {
      // Constant-time failure — avoid timing attacks
      await verifyPassword(password, '$2a$12$placeholder.hash.to.prevent.timing.attacks');
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_INACTIVE', message: 'Account is disabled' },
      });
    }

    // Verify password
    const passwordValid = await verifyPassword(password, user.password_hash as string);
    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    const firstName = (user.first_name as string) || '';
    const lastName = (user.last_name as string) || '';

    const authUser = {
      id: String(user.id),
      userId: String(user.id),
      email: user.email as string,
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim() || (user.email as string),
      role: user.role as AuthRole,
      permissions: (user.permissions as string[]) || [],
      isActive: true,
      profilePicture: user.profile_picture as string | undefined,
      department: user.department as string | undefined,
    };

    // Sign JWT and create DB session
    const ipAddress = Array.isArray(req.headers['x-forwarded-for'])
      ? req.headers['x-forwarded-for'][0]
      : req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    // Create session first, then sign token with the real sessionId
    // We pass a temporary token to createSession, then update the hash
    const tempToken = await signToken(authUser, 'pending');
    const session = await createSession(authUser.id, tempToken, ipAddress, userAgent);

    // Re-sign token with the real sessionId
    const finalToken = await signToken(authUser, session.id);

    // Update session with the hash of the final token
    const crypto = await import('crypto');
    const finalHash = crypto.createHash('sha256').update(finalToken).digest('hex');
    await sql`
      UPDATE user_sessions SET token_hash = ${finalHash} WHERE id = ${Number(session.id)}
    `;

    // Set HttpOnly cookie
    const authCookieString = serialize(AUTH_COOKIE_NAME, finalToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    const cookies = [authCookieString];
    if (user.onboarding_completed) {
      cookies.push(`ff_onboarding_done=1; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    }
    res.setHeader('Set-Cookie', cookies);

    log.info('User logged in', { userId: authUser.id, email: authUser.email }, 'auth/login');

    return apiResponse.success(res, { user: { ...authUser, onboardingCompleted: !!user.onboarding_completed } }, 'Login successful');
  } catch (err) {
    log.error('Login error', err instanceof Error ? { message: err.message } : { err }, 'auth/login');
    return apiResponse.internalError(res, err);
  }
}
