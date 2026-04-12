/**
 * User Impersonation Service
 * Creates a short-lived authenticated session allowing a super_admin to
 * log into the main application as any non-super_admin user.
 *
 * Security:
 *  - Session expires in 1 hour (much shorter than normal 1-day sessions).
 *  - Token hash is stored in user_sessions with metadata recording the admin.
 *  - Admin cannot impersonate another super_admin.
 *  - Target user must be active.
 */

import * as crypto from 'crypto';
import { sql } from '@/lib/neon';
import { signToken } from '@/lib/auth/jwt';
import { log } from '@/lib/logger';
import type { AuthUser, AuthRole } from '@/lib/auth/types';

const IMPERSONATION_EXPIRY_HOURS = 1;

interface TargetUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  is_active: boolean;
}

interface ImpersonationResult {
  token: string;
  sessionId: string;
  user: Pick<TargetUser, 'id' | 'email' | 'first_name' | 'last_name' | 'role'>;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Fetch target user — validates existence and active status.
 */
async function getTargetUser(userId: string): Promise<TargetUser | null> {
  const rows = await sql`
    SELECT id, email, first_name, last_name, role, is_active
    FROM users
    WHERE id = ${userId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id:         row.id         as string,
    email:      row.email      as string,
    first_name: row.first_name as string,
    last_name:  row.last_name  as string,
    role:       row.role       as string,
    is_active:  row.is_active  as boolean,
  };
}

/**
 * Create an impersonation session for the target user.
 * Returns a signed JWT and the session record id.
 */
export async function createUserImpersonationSession(
  adminUserId: string,
  targetUserId: string,
  ipAddress?: string
): Promise<ImpersonationResult> {
  // 1. Load and validate target user
  const target = await getTargetUser(targetUserId);
  if (!target) {
    throw new Error('Target user not found');
  }
  if (!target.is_active) {
    throw new Error('Cannot impersonate an inactive user');
  }
  if (target.role === 'super_admin') {
    throw new Error('Cannot impersonate another super_admin');
  }

  // 2. Build a minimal AuthUser for token signing
  const authUser: AuthUser = {
    id:           target.id,
    userId:       target.id,
    email:        target.email,
    firstName:    target.first_name ?? '',
    lastName:     target.last_name  ?? '',
    name:         `${target.first_name ?? ''} ${target.last_name ?? ''}`.trim(),
    role:         target.role as AuthRole,
    permissions:  [],
    isActive:     true,
  };

  // 3. Sign the JWT with a 1-hour expiry
  // We sign with a temporary placeholder sessionId first, then insert the
  // session, then re-sign with the real session id.  This keeps the JWT and
  // DB row in sync without a two-phase commit.
  const expiresAt = new Date(Date.now() + IMPERSONATION_EXPIRY_HOURS * 60 * 60 * 1000);

  // Insert session row — sessionId comes from SERIAL, so we get it back.
  const tempTokenRaw = crypto.randomBytes(32).toString('hex');
  const tempHash     = hashToken(tempTokenRaw);

  const [sessionRow] = await sql`
    INSERT INTO user_sessions (
      user_id,
      token_hash,
      expires_at,
      ip_address,
      metadata
    ) VALUES (
      ${target.id},
      ${tempHash},
      ${expiresAt.toISOString()},
      ${ipAddress ?? null},
      ${JSON.stringify({ impersonated_by: adminUserId })}
    )
    RETURNING id
  `;

  const sessionId = String(sessionRow?.id ?? '');
  if (!sessionId) {
    throw new Error('Failed to create impersonation session');
  }

  // 4. Sign the real JWT (includes sessionId now)
  const token = await signToken(authUser, sessionId, `${IMPERSONATION_EXPIRY_HOURS}h`);

  // 5. Update session row with the real token hash
  const realHash = hashToken(token);
  await sql`
    UPDATE user_sessions
    SET token_hash = ${realHash}
    WHERE id = ${sessionId}
  `;

  log.info('User impersonation session created', {
    adminUserId,
    targetUserId,
    sessionId,
    expiresAt: expiresAt.toISOString(),
  }, 'userImpersonationService');

  return {
    token,
    sessionId,
    user: {
      id:         target.id,
      email:      target.email,
      first_name: target.first_name,
      last_name:  target.last_name,
      role:       target.role,
    },
  };
}
