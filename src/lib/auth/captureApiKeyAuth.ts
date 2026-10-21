/**
 * Capture API Key authentication utilities.
 * Pure functions + one DB query — no HTTP concerns.
 * Used by the upload endpoint to accept Bearer-token auth from external apps.
 */

import { createHash, randomBytes } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { LIVE_COMPANY_SQL } from './companyMembership';
import { isActiveUserAccount, type UserAccountRow } from './userAccountStatus';
import { canWrite } from './writeRoles';

/** The role a legacy key (no recorded creator) acts with. */
const LEGACY_KEY_ROLE = 'manager';

export interface ApiKeyContext {
  companyId: string;
  keyId: string;
  label: string;
  /** The creator's CURRENT role in the company, or 'manager' for a legacy key with no creator. */
  role: string;
}

type KeyRow = UserAccountRow & {
  id: string;
  company_id: string;
  label: string;
  key_prefix: string;
  created_by: string | null;
  company_live: boolean;
  role: string | null;
  account_user_id: string | null;
};

/**
 * Generate a new raw key, its SHA-256 hash, and the display prefix.
 * The raw key is returned ONCE and must be shown to the user immediately —
 * only the hash is persisted.
 */
export function generateCaptureApiKey(): { raw: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString('hex');
  const raw = `isa_live_${secret}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 16); // "isa_live_" + 7 chars
  return { raw, hash, prefix };
}

/**
 * Why a stored key may no longer act for its company, or null when it may.
 * A key is a standing credential that bypasses withAuth, so it holds only
 * while what withAuth would demand of its creator still holds (S-06): the
 * company live (LIVE_COMPANY_SQL, the predicate getCompanyMembership uses)
 * and the creator a current member who can write, with an account in good
 * standing. A legacy key with no creator answers to company standing only.
 */
function keyRefusal(row: KeyRow): string | null {
  if (!row.company_live) return 'company is suspended or deleted';
  if (row.created_by === null) return null;
  if (row.role === null) return 'creator is not a member of the company';
  if (!canWrite(row.role)) return 'creator is no longer an owner, admin or manager of the company';
  if (row.account_user_id === null) return 'creator has no users profile';
  if (!isActiveUserAccount(row)) return 'creator account is not in good standing';
  return null;
}

/**
 * Validate a raw API key from an incoming request.
 * Returns null if the key is unknown, revoked, or malformed, or if its company
 * or creator is no longer in standing (keyRefusal). The context carries the
 * role the key acts with.
 * Updates last_used_at fire-and-forget so the hot path is not blocked.
 *
 * Runs on the app pool with no request transaction and no claims, so it
 * relies on that role bypassing RLS, as the pre-auth reads in liveCompanies.ts do.
 */
export async function validateCaptureApiKey(rawKey: string): Promise<ApiKeyContext | null> {
  if (!rawKey.startsWith('isa_live_')) return null;

  const hash = createHash('sha256').update(rawKey).digest('hex');

  // company_users.user_id, users.id and created_by are all TEXT: no casts.
  const rows = await sql<KeyRow>`
    SELECT k.id, k.company_id, k.label, k.key_prefix, k.created_by,
           (${sql.unsafe(LIVE_COMPANY_SQL)}) AS company_live,
           cu.role,
           u.id AS account_user_id,
           u.is_active,
           u.status,
           u.suspended_at
    FROM capture_api_keys k
    JOIN companies c ON c.id = k.company_id
    LEFT JOIN company_users cu ON cu.company_id = k.company_id AND cu.user_id = k.created_by
    LEFT JOIN users u ON u.id = cu.user_id
    WHERE k.key_hash = ${hash}
      AND k.is_active = true
      AND k.revoked_at IS NULL
    LIMIT 1
  `;

  if (rows.length === 0) {
    log.warn('captureApiKey: invalid or revoked key presented', {}, 'capture-api-key');
    return null;
  }

  const row = rows[0]!;
  const reason = keyRefusal(row);
  if (reason) {
    log.warn('captureApiKey: key refused', { keyId: row.id, companyId: row.company_id, reason }, 'capture-api-key');
    return null;
  }
  if (row.created_by === null) {
    // The prefix (shown in the keys list) identifies the key; the secret is never logged.
    log.warn(
      'captureApiKey: legacy key with no creator used; it acts as manager until re-issued',
      { keyId: row.id, keyPrefix: row.key_prefix },
      'capture-api-key',
    );
  }

  // Fire-and-forget — do not block the upload on a timestamp update
  sql`
    UPDATE capture_api_keys
    SET last_used_at = NOW()
    WHERE id = ${row.id}::uuid
  `.catch((err: unknown) =>
    log.warn(
      'captureApiKey: failed to update last_used_at',
      { err: err instanceof Error ? err.message : String(err) },
      'capture-api-key',
    ),
  );

  return {
    companyId: row.company_id,
    keyId: row.id,
    label: row.label,
    role: row.role ?? LEGACY_KEY_ROLE,
  };
}

/**
 * Extract a Bearer token from the Authorization header.
 * Returns null if the header is absent or not a Bearer scheme.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}
