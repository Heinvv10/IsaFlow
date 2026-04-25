/**
 * Capture API Key authentication utilities.
 * Pure functions + one DB query — no HTTP concerns.
 * Used by the upload endpoint to accept Bearer-token auth from external apps.
 */

import { createHash, randomBytes } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

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
 * Validate a raw API key from an incoming request.
 * Returns null if the key is unknown, revoked, or malformed.
 * Updates last_used_at fire-and-forget so the hot path is not blocked.
 */
export async function validateCaptureApiKey(rawKey: string): Promise<ApiKeyContext | null> {
  if (!rawKey.startsWith('isa_live_')) return null;

  const hash = createHash('sha256').update(rawKey).digest('hex');

  const rows = await sql`
    SELECT id, company_id, label
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

  // Fire-and-forget — do not block the upload on a timestamp update
  sql`
    UPDATE capture_api_keys
    SET last_used_at = NOW()
    WHERE id = ${row.id as string}::uuid
  `.catch((err: unknown) =>
    log.warn(
      'captureApiKey: failed to update last_used_at',
      { err: err instanceof Error ? err.message : String(err) },
      'capture-api-key',
    ),
  );

  return {
    companyId: row.company_id as string,
    keyId: row.id as string,
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
