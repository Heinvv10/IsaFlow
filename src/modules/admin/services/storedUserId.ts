/**
 * users.id is TEXT holding a (GoTrue) UUID, so the same user can be named in any letter case, and two rows can even
 * differ only in case. The ONE resolver for "which stored user does this id name": the exact match first, else a
 * case-insensitive one (review #1407, breaker #1405 rounds 5-6). Password reset, reset-2fa and the audit log's
 * target_id use it, so a refusal, the act and its audit row are all about the same stored row.
 */
import { sql } from '@/lib/neon';
import { AdminRequestError, adminUserId } from '@/modules/admin/middleware/adminRequestErrors';

export interface StoredUser {
  /** users.id exactly as stored. */
  id: string;
  role: string | null;
}

export async function findStoredUser(userId: string): Promise<StoredUser | null> {
  const rows = await sql<{ id: string; role: string | null }>`
    SELECT id, role FROM users WHERE lower(id) = lower(${userId})
    ORDER BY (id = ${userId}) DESC, id
    LIMIT 1
  `;
  return rows[0] ? { id: String(rows[0].id), role: rows[0].role ?? null } : null;
}

/**
 * The stored user a route's `[id]` names, or a 404 AdminRequestError. Every admin route that acts on and audits a
 * 'user' target takes its id from here (review #1405 round 7): it acts and audits on that exact stored id. The audit
 * log never re-maps a user id afterwards (it could pick a different row once the named one is gone).
 * A plain read: no lock (the lock order for a user's rows is company_users -> users -> user_sessions).
 */
export async function adminStoredUser(value: unknown): Promise<StoredUser> {
  const user = await findStoredUser(adminUserId(value));
  if (!user) throw new AdminRequestError(404, 'User not found');
  return user;
}
