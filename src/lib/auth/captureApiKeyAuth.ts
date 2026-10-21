/**
 * Capture API Key authentication utilities.
 * Pure functions + one DB query — no HTTP concerns.
 * Used by the upload endpoint to accept Bearer-token auth from external apps.
 */

import { createHash, randomBytes } from 'crypto';
import { sql, getPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getCompanyMembership } from './companyMembership';
import { isActiveUserAccount } from './userAccountStatus';
import { canWrite } from './writeRoles';

type Row = Record<string, unknown>;

export interface ApiKeyContext {
  companyId: string;
  keyId: string;
  label: string;
}

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
 * Why a stored key no longer speaks for its company, or null when it still
 * does. A key is a standing credential that bypasses withAuth, so it holds
 * only while what withAuth would demand of its creator still holds (S-06):
 * the company in good standing and the creator a current owner, admin or
 * manager of it, with an account in good standing. Standing comes from
 * getCompanyMembership, the one rule withAuth applies, not a copy of it.
 *
 * Runs on the app pool with no request transaction: like the key lookup,
 * it relies on that role bypassing RLS (no claims are set here).
 */
async function keyRefusal(companyId: string, createdBy: string | null): Promise<string | null> {
  if (!createdBy) return 'key has no recorded creator';
  const client = await getPool().connect();
  let membership: Awaited<ReturnType<typeof getCompanyMembership>>;
  try {
    membership = await getCompanyMembership(client, createdBy, companyId);
  } finally {
    client.release();
  }
  const member = membership.rows[0];
  if (!member) return 'creator is not a member of the company, or the company is suspended or deleted';
  if (!canWrite(member.role)) return 'creator is no longer an owner, admin or manager of the company';
  if (member.account_user_id === null || !isActiveUserAccount(member)) return 'creator account is not in good standing';
  return null;
}

/**
 * Validate a raw API key from an incoming request.
 * Returns null if the key is unknown, revoked, or malformed, or if its company
 * or creator is no longer in standing (keyRefusal).
 * Updates last_used_at fire-and-forget so the hot path is not blocked.
 */
export async function validateCaptureApiKey(rawKey: string): Promise<ApiKeyContext | null> {
  if (!rawKey.startsWith('isa_live_')) return null;

  const hash = createHash('sha256').update(rawKey).digest('hex');

  const rows = await sql`
    SELECT id, company_id, label, created_by
    FROM capture_api_keys
    WHERE key_hash = ${hash}
      AND is_active = true
    LIMIT 1
  ` as Row[];

  if (rows.length === 0) {
    log.warn('captureApiKey: invalid or revoked key presented', {}, 'capture-api-key');
    return null;
  }

  const row = rows[0]!;
  const keyId = row.id as string;
  const companyId = row.company_id as string;

  const reason = await keyRefusal(companyId, (row.created_by as string | null) ?? null);
  if (reason) {
    log.warn('captureApiKey: key refused', { keyId, companyId, reason }, 'capture-api-key');
    return null;
  }

  // Fire-and-forget — do not block the upload on a timestamp update
  sql`
    UPDATE capture_api_keys
    SET last_used_at = NOW()
    WHERE id = ${keyId}::uuid
  `.catch((err: unknown) =>
    log.warn(
      'captureApiKey: failed to update last_used_at',
      { err: err instanceof Error ? err.message : String(err) },
      'capture-api-key',
    ),
  );

  return {
    companyId,
    keyId,
    label: row.label as string,
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
