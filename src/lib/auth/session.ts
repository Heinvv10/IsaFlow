/**
 * Session Management
 * Database-backed session handling for token revocation and multi-device support
 */

import { sql } from '@/lib/neon';
import * as crypto from 'crypto';
import type { Session } from './types';

// Session expiry set to 1 day to approximate the 8h JWT ACCESS_TOKEN_EXPIRY.
// TODO: Implement a proper refresh-token flow so DB sessions and JWTs share the
// same expiry. Until then, the JWT expires first (8h) and the DB session row
// is cleaned up lazily. Setting 30d here created a window where a revoked JWT
// could not be fully invalidated via the session table.
const SESSION_EXPIRY_DAYS = 1;

/**
 * Create a hash of the token for storage
 * We don't store the actual token, just a hash for comparison
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create a new session for a user
 */
export async function createSession(
  userId: string,
  token: string,
  ipAddress?: string,
  userAgent?: string
): Promise<Session> {
  const tokenHash = hashToken(token);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_EXPIRY_DAYS);

  const rows = await sql`
    INSERT INTO user_sessions (user_id, token_hash, expires_at, ip_address, user_agent)
    VALUES (${userId}, ${tokenHash}, ${expiresAt.toISOString()}, ${ipAddress || null}, ${userAgent || null})
    RETURNING id
  `;

  const sessionId = String(rows[0]?.id ?? '');

  return {
    id: sessionId,
    userId,
    tokenHash,
    expiresAt,
    createdAt: new Date(),
    ipAddress,
    userAgent,
  };
}

/**
 * Validate a session exists and is not expired
 */
export async function validateSession(
  sessionId: string,
  token: string
): Promise<boolean> {
  const tokenHash = hashToken(token);

  const result = await sql`
    SELECT id, expires_at
    FROM user_sessions
    WHERE id = ${sessionId}
      AND token_hash = ${tokenHash}
      AND expires_at > NOW()
  `;

  return result.length > 0;
}

/**
 * Get session by ID
 */
export async function getSession(sessionId: string): Promise<Session | null> {
  const result = await sql`
    SELECT id, user_id, token_hash, expires_at, created_at, ip_address, user_agent
    FROM user_sessions
    WHERE id = ${sessionId}
      AND expires_at > NOW()
  `;

  const row = result[0];
  if (!row) return null;

  return {
    id: row.id as string,
    userId: row.user_id as string,
    tokenHash: row.token_hash as string,
    expiresAt: new Date(row.expires_at as string),
    createdAt: new Date(row.created_at as string),
    ipAddress: row.ip_address as string | undefined,
    userAgent: row.user_agent as string | undefined,
  };
}

/**
 * Delete a specific session (logout)
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await sql`
    DELETE FROM user_sessions
    WHERE id = ${sessionId}
  `;
}

/**
 * Delete all sessions for a user (logout everywhere)
 */
export async function deleteAllUserSessions(userId: string): Promise<void> {
  await sql`
    DELETE FROM user_sessions
    WHERE user_id = ${userId}
  `;
}

/**
 * Get all active sessions for a user
 */
export async function getUserSessions(userId: string): Promise<Session[]> {
  const result = await sql`
    SELECT id, user_id, token_hash, expires_at, created_at, ip_address, user_agent
    FROM user_sessions
    WHERE user_id = ${userId}
      AND expires_at > NOW()
    ORDER BY created_at DESC
  `;

  return result.map((row) => ({
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  }));
}

/**
 * Clean up expired sessions (run periodically)
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await sql`
    DELETE FROM user_sessions
    WHERE expires_at < NOW()
    RETURNING id
  `;

  return result.length;
}

/**
 * Extend session expiry (refresh)
 */
export async function extendSession(sessionId: string): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_EXPIRY_DAYS);

  await sql`
    UPDATE user_sessions
    SET expires_at = ${expiresAt.toISOString()}
    WHERE id = ${sessionId}
  `;
}
