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
import { get2FAStatus, isTrustedDevice } from '@/modules/auth/services/twoFactorService';
import { checkRateLimit } from '@/lib/rateLimit';
import { withErrorHandler } from '@/lib/api-error-handler';
type Row = Record<string, unknown>;

// Real bcrypt hash of 'timing-safe-dummy' at cost 12, used for constant-time rejection.
const TIMING_SAFE_HASH = '$2a$12$K4GByFHHbpZQKxVKzPEfXOdQuGfe0gPISQEFMEfcrrKjAXBgmC.Xq';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['POST']);
  }

  // Rate limit: 5 attempts per IP per 15 minutes
  // Use the last x-forwarded-for entry (proxy-appended) to prevent client IP spoofing.
  const ip: string = (() => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const raw = Array.isArray(forwarded) ? forwarded[0] ?? '' : forwarded;
      const ips = raw.split(',').map((s: string) => s.trim());
      return ips[ips.length - 1] || req.socket.remoteAddress || 'unknown';
    }
    return req.socket.remoteAddress || 'unknown';
  })();
  if (checkRateLimit(ip, { windowMs: 15 * 60 * 1000, maxRequests: 5 })) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
    });
  }

  const { email, password, deviceFingerprint } = req.body as {
    email?: string;
    password?: string;
    deviceFingerprint?: string;
  };

  if (!email || !password) {
    return apiResponse.badRequest(res, 'Email and password are required');
  }

  try {
    // Look up user by email
    const rows = (await sql`
      SELECT id, email, password_hash, first_name, last_name, role,
             is_active, permissions, profile_picture, department, onboarding_completed,
             failed_login_attempts, locked_until
      FROM users
      WHERE email = ${email.toLowerCase().trim()}
      LIMIT 1
    `) as Row[];

    const user = rows[0];

    if (!user) {
      // Constant-time failure — avoid timing attacks
      await verifyPassword(password, TIMING_SAFE_HASH);
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

    // Check account lockout
    if (user.locked_until) {
      const lockedUntil = user.locked_until instanceof Date ? user.locked_until : new Date(user.locked_until as string);
      if (lockedUntil > new Date()) {
        const minutesRemaining = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000);
        return res.status(403).json({
          success: false,
          error: {
            code: 'ACCOUNT_LOCKED',
            message: `Account locked due to too many failed attempts. Try again in ${minutesRemaining} minute(s).`,
          },
        });
      }
    }

    // Verify password
    const passwordValid = await verifyPassword(password, user.password_hash as string);
    if (!passwordValid) {
      // Increment failed attempts; lock after 10 failures
      const attempts = ((user.failed_login_attempts as number) ?? 0) + 1;
      if (attempts >= 10) {
        await sql`
          UPDATE users
          SET failed_login_attempts = ${attempts},
              locked_until = NOW() + INTERVAL '30 minutes'
          WHERE id = ${user.id as string}
        `;
        log.warn('Account locked after failed attempts', { userId: user.id, attempts }, 'auth/login');
      } else {
        await sql`
          UPDATE users SET failed_login_attempts = ${attempts} WHERE id = ${user.id as string}
        `;
      }
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
    }

    // Check 2FA before creating a full session
    const twoFAStatus = await get2FAStatus(String(user.id));
    if (twoFAStatus.enabled) {
      // Check if device is already trusted
      const trusted = deviceFingerprint
        ? await isTrustedDevice(String(user.id), deviceFingerprint)
        : false;

      if (!trusted) {
        // Issue a short-lived temp token (5 min) — no DB session yet
        const tempAuthUser = {
          id: String(user.id),
          userId: String(user.id),
          email: user.email as string,
          firstName: (user.first_name as string) || '',
          lastName: (user.last_name as string) || '',
          name: '',
          role: user.role as AuthRole,
          permissions: [],
          isActive: true,
        };
        const tempToken = await signToken(tempAuthUser, '2fa-pending', '5m');
        log.info('2FA required — temp token issued', { userId: user.id }, 'auth/login');
        return res.status(200).json({
          success: true,
          data: { requiresTwoFactor: true, tempToken },
        });
      }
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

    // Sign JWT and create DB session — reuse the already-resolved safe IP
    const ipAddress = ip;
    const userAgent = req.headers['user-agent'];

    // Reset failed login attempts on successful password verification
    await sql`
      UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ${authUser.id}
    `;

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

    // Set HttpOnly cookie — 8h session, always secure
    const isProd = process.env.NODE_ENV === 'production';
    const authCookieString = serialize(AUTH_COOKIE_NAME, finalToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 8 * 60 * 60, // 8 hours
      ...(isProd ? { domain: '.isaflow.co.za' } : {}),
    });

    // Auto-accept any pending company invitations for this email
    let invitationsAccepted = 0;
    let onboardingCompleted = !!user.onboarding_completed;

    const pendingInvitations = (await sql`
      SELECT id, company_id, role
      FROM company_invitations
      WHERE LOWER(email) = LOWER(${authUser.email})
        AND accepted_at IS NULL
        AND expires_at > NOW()
    `) as Row[];

    for (const inv of pendingInvitations) {
      await sql`
        INSERT INTO company_users (company_id, user_id, role, is_default)
        VALUES (${inv.company_id as string}::UUID, ${authUser.id}::UUID, ${inv.role as string}, false)
        ON CONFLICT (company_id, user_id) DO NOTHING
      `;
      await sql`
        UPDATE company_invitations SET accepted_at = NOW() WHERE id = ${inv.id as string}::UUID
      `;
      invitationsAccepted++;
    }

    if (invitationsAccepted > 0 && !onboardingCompleted) {
      await sql`UPDATE users SET onboarding_completed = true WHERE id = ${authUser.id}`;
      onboardingCompleted = true;
      log.info('Onboarding skipped via invitation acceptance', { userId: authUser.id, invitationsAccepted }, 'auth/login');
    }

    // If user already belongs to a company, they're onboarded — fix stale DB flag
    if (!onboardingCompleted) {
      const companyCheck = (await sql`
        SELECT 1 FROM company_users WHERE user_id = ${authUser.id}::UUID LIMIT 1
      `) as Row[];
      if (companyCheck.length > 0) {
        await sql`UPDATE users SET onboarding_completed = true WHERE id = ${authUser.id}`;
        onboardingCompleted = true;
        log.info('Onboarding auto-completed — user already has a company', { userId: authUser.id }, 'auth/login');
      }
    }

    // Auto-dismiss accounting tour for existing users (prevents tour on every login)
    if (onboardingCompleted) {
      await sql`
        INSERT INTO user_preferences (user_id, key, value, updated_at)
        VALUES (${authUser.id}, 'onboarding_tour_completed', 'true', NOW())
        ON CONFLICT (user_id, key) DO NOTHING
      `;
    }

    const cookies = [authCookieString];
    if (onboardingCompleted) {
      const domainSuffix = isProd ? '; Domain=.isaflow.co.za' : '';
      cookies.push(`ff_onboarding_done=1; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax${isProd ? '; Secure' : ''}${domainSuffix}`);
    }
    res.setHeader('Set-Cookie', cookies);

    log.info('User logged in', { userId: authUser.id, email: authUser.email }, 'auth/login');

    return apiResponse.success(res, {
      user: { ...authUser, onboardingCompleted },
      invitationsAccepted,
    }, 'Login successful');
  } catch (err) {
    log.error('Login error', err instanceof Error ? { message: err.message } : { err }, 'auth/login');
    return apiResponse.internalError(res, err);
  }
}

export default withErrorHandler(handler);
