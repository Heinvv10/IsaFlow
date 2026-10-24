/**
 * The authenticated side of share links: create, list, revoke. The public side
 * lives in shareResolver.ts and shares no code path with this file beyond the
 * token hash function.
 *
 * The raw token is returned by createShareLink and NEVER again — not by
 * listShareLinks, not by any route. A lost link is re-created, not recovered.
 *
 * Create and revoke run on the migration_admin pool (S-07d, migration 935): a
 * row is a read credential for its company's reports, so no app role may
 * INSERT or UPDATE share_links (forged claims planted a hash of a known token,
 * or revived a revoked link). `companyId` and `userId` are the verified
 * request's. The view counter stays on the app pools (shareResolver).
 */
import { sql, type DbRow } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { log } from '@/lib/logger';
import { mintShareToken, hashShareToken } from './shareToken';
import { clampTtlDays } from './shareTtl';
import type { SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';

export interface ShareLinkRow {
  id: string;
  reportKind: 'pack';
  params: SharePackParams;
  label: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  viewCount: number;
  lastViewedAt: string | null;
}

/** Live links a company may hold at once. The list below reads at most 200
 *  rows, so a cap under that is what stops a company minting links it can no
 *  longer see in order to revoke them. */
export const MAX_LIVE_LINKS = 100;

/** Thrown by createShareLink when the company is already at MAX_LIVE_LINKS.
 *  Distinguishable so the route can answer 409 rather than a blanket 500. */
export class ShareLinkLimitError extends Error {
  constructor() {
    super(`This company already has ${MAX_LIVE_LINKS} live share links. Revoke one before creating another.`);
    this.name = 'ShareLinkLimitError';
  }
}

function toRow(r: DbRow): ShareLinkRow {
  return {
    id: String(r.id),
    reportKind: 'pack',
    params: r.params as SharePackParams,
    label: r.label === null || r.label === undefined ? null : String(r.label),
    expiresAt: new Date(r.expires_at).toISOString(),
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    createdBy: String(r.created_by),
    createdAt: new Date(r.created_at).toISOString(),
    viewCount: Number(r.view_count),
    lastViewedAt: r.last_viewed_at ? new Date(r.last_viewed_at).toISOString() : null,
  };
}

export async function createShareLink(input: {
  companyId: string;
  userId: string;
  params: SharePackParams;
  label?: string;
  ttlDays?: number;
}): Promise<{ link: ShareLinkRow; token: string }> {
  const token = mintShareToken();
  const ttl = clampTtlDays(input.ttlDays);
  // The count in the guard below does NOT serialise anything on its own. Under
  // READ COMMITTED each session's subquery reads a snapshot that cannot see the
  // other's uncommitted row, so two concurrent creates at 99 live links both
  // pass the guard and land 101 — reproduced against a live database. The
  // advisory lock is what closes it: transaction-scoped, released on COMMIT or
  // ROLLBACK, and keyed per company so two tenants never block each other.
  // Same shape as acquireIdempotencyLock in src/lib/mcp/audit.ts.
  const rows = await migrationAdminTx('create share link', async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`share:link-create:${input.companyId}`]);
    return (await client.query(
      `INSERT INTO share_links (company_id, report_kind, params, token_hash, label, expires_at, created_by)
       SELECT $1::uuid, 'pack', $2::jsonb, $3, $4, NOW() + ($5::text || ' days')::interval, $6
        WHERE (
          SELECT COUNT(*) FROM share_links
           WHERE company_id = $1::uuid
             AND revoked_at IS NULL
             AND expires_at > NOW()
        ) < $7::int
       RETURNING *`,
      [input.companyId, JSON.stringify(input.params), hashShareToken(token), input.label ?? null, ttl, input.userId, MAX_LIVE_LINKS],
    )).rows as DbRow[];
  });
  if (rows.length === 0) throw new ShareLinkLimitError();
  const link = toRow(rows[0]!);
  log.info('Share link created', {
    companyId: input.companyId, userId: input.userId, shareLinkId: link.id,
    packType: input.params.type, from: input.params.from, to: input.params.to, ttlDays: ttl,
  }, 'share');
  return { link, token };
}

/** Live links only — a revoked or expired link is history, and listing it
 *  would let dead rows crowd live ones out of the 200-row page, leaving a live
 *  link past row 200 visible nowhere and therefore revocable nowhere. */
export async function listShareLinks(companyId: string): Promise<ShareLinkRow[]> {
  const rows = (await sql`
    SELECT id, params, label, expires_at, revoked_at, created_by, created_at, view_count, last_viewed_at
    FROM share_links
    WHERE company_id = ${companyId}::uuid
      AND revoked_at IS NULL
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 200
  `) as DbRow[];
  return rows.map(toRow);
}

/** Returns false when the id does not belong to this company — the caller
 *  answers 404, so a cross-company id and a missing id are indistinguishable. */
export async function revokeShareLink(companyId: string, id: string, userId: string): Promise<boolean> {
  const rows = await migrationAdminTx('revoke share link', async (client) => (await client.query(
    `UPDATE share_links
        SET revoked_at = NOW(), revoked_by = $3
      WHERE id = $1::uuid AND company_id = $2::uuid AND revoked_at IS NULL
      RETURNING id`,
    [id, companyId, userId],
  )).rows as DbRow[]);
  if (rows.length === 0) return false;
  log.info('Share link revoked', { companyId, userId, shareLinkId: id }, 'share');
  return true;
}
