/**
 * The authenticated side of share links: create, list, revoke. The public side
 * lives in shareResolver.ts and shares no code path with this file beyond the
 * token hash function.
 *
 * The raw token is returned by createShareLink and NEVER again — not by
 * listShareLinks, not by any route. A lost link is re-created, not recovered.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { mintShareToken, hashShareToken } from './shareToken';
import type { SharePackParams } from './shareParams';

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

const MAX_TTL_DAYS = 90;
const DEFAULT_TTL_DAYS = 30;

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

/** Clamp to [1, 90] days. A caller-supplied ttl is a convenience, not a way to
 *  mint a link that outlives the engagement. */
export function clampTtlDays(days: number | undefined): number {
  const n = Math.trunc(days ?? DEFAULT_TTL_DAYS);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TTL_DAYS;
  return Math.min(n, MAX_TTL_DAYS);
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
  // The cap is enforced INSIDE the insert rather than by a preceding SELECT:
  // one statement, so two concurrent creates cannot both read a count of 99
  // and both write. No row back means the guard rejected it.
  const rows = (await sql`
    INSERT INTO share_links (company_id, report_kind, params, token_hash, label, expires_at, created_by)
    SELECT
      ${input.companyId}::uuid, 'pack', ${JSON.stringify(input.params)}::jsonb,
      ${hashShareToken(token)}, ${input.label ?? null},
      NOW() + (${ttl} || ' days')::interval, ${input.userId}
    WHERE (
      SELECT COUNT(*) FROM share_links
      WHERE company_id = ${input.companyId}::uuid
        AND revoked_at IS NULL
        AND expires_at > NOW()
    ) < ${MAX_LIVE_LINKS}
    RETURNING *
  `) as DbRow[];
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
  const rows = (await sql`
    UPDATE share_links
    SET revoked_at = NOW(), revoked_by = ${userId}
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND revoked_at IS NULL
    RETURNING id
  `) as DbRow[];
  if (rows.length === 0) return false;
  log.info('Share link revoked', { companyId, userId, shareLinkId: id }, 'share');
  return true;
}
