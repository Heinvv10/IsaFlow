/**
 * Personal Access Token (PAT) authentication — PRD-10 Layer 3.
 * Pure functions + DB queries. Mirrors src/lib/auth/captureApiKeyAuth.ts but
 * with user-scoped tokens and explicit scope vocabulary.
 *
 * Token format: pat_<32 base62 chars>. SHA-256 of the full plaintext stored in
 * personal_access_tokens.token_hash. Plaintext is shown to the user ONCE at
 * creation; revocation is instant (revoked_at IS NULL filter on every lookup).
 */

import { createHash, randomBytes } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

/** Scope vocabulary for PRD-10 Layer 3. Canonical list lives in the
 *  zero-import patScopes.ts (client-bundle safe); re-exported here for
 *  server-side consumers. Layer 2 (OAuth) extends this. */
export { PAT_SCOPES, type PatScope } from './patScopes';
import { PAT_SCOPES } from './patScopes';

export interface PatContext {
  patId: string;
  userId: string;
  companyId: string;
  scopes: string[];
}

/**
 * Generate a new raw PAT, its SHA-256 hash, and a display prefix.
 * Raw token must be shown to the user immediately — only the hash persists.
 */
export function generatePat(): { raw: string; hash: string; prefix: string } {
  // 32 bytes → 43 base64url chars; we use base62 by stripping non-alphanumerics
  // from base64. Rejection-sampling keeps it simple and deterministic in length.
  let body = '';
  while (body.length < 32) {
    const chunk = randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '');
    body += chunk;
  }
  body = body.slice(0, 32);
  const raw = `pat_${body}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12); // "pat_" + 8 chars — safe for display
  return { raw, hash, prefix };
}

/**
 * Look up an active, non-expired PAT by raw token. Returns null on miss.
 * Updates last_used_{at,ip} fire-and-forget.
 */
export async function validatePat(rawToken: string, ip: string | null): Promise<PatContext | null> {
  if (!rawToken.startsWith('pat_')) return null;

  const hash = createHash('sha256').update(rawToken).digest('hex');

  const rows = (await sql`
    SELECT id, user_id, company_id, scopes
    FROM personal_access_tokens
    WHERE token_hash = ${hash}
      AND revoked_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `) as Row[];

  if (rows.length === 0) {
    log.warn('PAT: invalid, revoked, or expired token presented', {}, 'pat');
    return null;
  }

  const row = rows[0]!;

  // Fire-and-forget — never block the request on a timestamp update.
  sql`
    UPDATE personal_access_tokens
    SET last_used_at = NOW(), last_used_ip = ${ip}::inet
    WHERE id = ${row.id as string}::uuid
  `.catch((err: unknown) =>
    log.warn(
      'PAT: failed to update last_used_at',
      { err: err instanceof Error ? err.message : String(err) },
      'pat',
    ),
  );

  return {
    patId: row.id as string,
    userId: row.user_id as string,
    companyId: row.company_id as string,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
  };
}

export interface PatListItem {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function listPats(userId: string, companyId: string): Promise<PatListItem[]> {
  const rows = (await sql`
    SELECT id, name, token_prefix, scopes, expires_at, last_used_at, created_at
    FROM personal_access_tokens
    WHERE user_id = ${userId}
      AND company_id = ${companyId}::uuid
      AND revoked_at IS NULL
    ORDER BY created_at DESC
  `) as Row[];

  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    prefix: r.token_prefix as string,
    scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
    expiresAt: (r.expires_at as Date).toISOString(),
    lastUsedAt: r.last_used_at ? (r.last_used_at as Date).toISOString() : null,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

export interface CreatePatInput {
  userId: string;
  companyId: string;
  name: string;
  scopes: string[];
  expiresInDays: number;
}

export async function createPat(input: CreatePatInput): Promise<{ id: string; raw: string; prefix: string }> {
  // Defence-in-depth — API layer also validates against PAT_SCOPES, but if
  // createPat is ever called from another path (e.g. future OAuth Layer 2
  // re-using the table) we must not accept arbitrary scope strings.
  const validScopes = new Set<string>(PAT_SCOPES);
  for (const s of input.scopes) {
    if (!validScopes.has(s)) {
      throw new Error(`createPat: unknown scope "${s}"`);
    }
  }

  const { raw, hash, prefix } = generatePat();
  const days = Math.max(1, Math.min(365, Math.floor(input.expiresInDays)));

  const rows = (await sql`
    INSERT INTO personal_access_tokens
      (user_id, company_id, token_hash, token_prefix, name, scopes, expires_at)
    VALUES (
      ${input.userId},
      ${input.companyId}::uuid,
      ${hash},
      ${prefix},
      ${input.name},
      ${input.scopes},
      NOW() + (${days} || ' days')::interval
    )
    RETURNING id
  `) as Row[];

  if (!rows[0]) throw new Error('createPat: insert returned no row');

  log.info('PAT created', { userId: input.userId, companyId: input.companyId, name: input.name, scopes: input.scopes }, 'pat');
  return { id: rows[0].id as string, raw, prefix };
}

export async function revokePat(id: string, userId: string, companyId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE personal_access_tokens
    SET revoked_at = NOW()
    WHERE id = ${id}::uuid
      AND user_id = ${userId}
      AND company_id = ${companyId}::uuid
      AND revoked_at IS NULL
    RETURNING id
  `) as Row[];

  const ok = rows.length > 0;
  if (ok) log.info('PAT revoked', { id, userId, companyId }, 'pat');
  return ok;
}
