/**
 * Active Announcements API — Customer-facing
 * GET /api/announcements/active
 * Returns currently active announcements for the authenticated user's company.
 * Filters by target: 'all', or 'company' (matching company_id), or 'plan' (matching plan_id), and leaves out
 * what this user has dismissed. Sends no target_ids / created_by: those name other tenants and admins.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { DISMISS_KEY_PREFIX, type TenantAnnouncement } from '@/lib/tenantAnnouncements';
type Row = Record<string, unknown>;


function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v as string;
}

function rowToAnnouncement(r: Row): TenantAnnouncement {
  return {
    id:             r.id as string,
    title:          r.title as string,
    message:        r.message as string,
    type:           r.type as TenantAnnouncement['type'],
    starts_at:      toIso(r.starts_at) as string,
    ends_at:        toIso(r.ends_at),
    is_dismissible: r.is_dismissible as boolean,
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId, user } = req as CompanyAuthedRequest;

  try {
    // Plan target: any of the company's live subscriptions (a company can hold more than one row).
    // A user's dismissal hides a dismissible announcement only: a not-dismissible one ignores it.
    const rows = await sql`
      SELECT a.id, a.title, a.message, a.type, a.starts_at, a.ends_at, a.is_dismissible
      FROM system_announcements a
      WHERE a.starts_at <= NOW()
        AND (a.ends_at IS NULL OR a.ends_at >= NOW())
        AND (
          a.target = 'all'
          OR (a.target = 'company' AND ${companyId}::uuid = ANY(a.target_ids))
          OR (
            a.target = 'plan'
            AND a.target_ids && ARRAY(
              SELECT s.plan_id FROM subscriptions s
              WHERE s.company_id = ${companyId}::uuid AND s.status IN ('active', 'trial')
            )
          )
        )
        AND (
          NOT a.is_dismissible
          OR NOT EXISTS (
            SELECT 1 FROM user_preferences up
            WHERE up.user_id = ${user.id}
              AND up.key = ${DISMISS_KEY_PREFIX}::text || a.id::text
          )
        )
      ORDER BY a.starts_at DESC
    `;

    return apiResponse.success(res, (rows as Row[]).map(rowToAnnouncement));
  } catch (err) {
    log.error('Failed to fetch active announcements', { companyId, error: err }, 'announcements-api');
    return apiResponse.badRequest(res, 'Failed to fetch active announcements');
  }
}

 
export default withAuth(withErrorHandler(handler));
