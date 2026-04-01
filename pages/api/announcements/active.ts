/**
 * Active Announcements API — Customer-facing
 * GET /api/announcements/active
 * Returns currently active announcements for the authenticated user's company.
 * Filters by target: 'all', or 'company' (matching company_id), or 'plan' (matching plan_id).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { Announcement } from '@/modules/admin/types/admin.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return v as string;
}

function rowToAnnouncement(r: Row): Announcement {
  return {
    id:            r.id as string,
    title:         r.title as string,
    message:       r.message as string,
    type:          r.type as string,
    target:        r.target as string,
    target_ids:    (r.target_ids ?? []) as string[],
    starts_at:     toIso(r.starts_at) as string,
    ends_at:       toIso(r.ends_at),
    is_dismissible: r.is_dismissible as boolean,
    created_by:    r.created_by as string,
    created_at:    toIso(r.created_at) as string,
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    // Fetch the company's plan_id for plan-targeted announcements
    const [companyRow] = await sql`
      SELECT s.plan_id
      FROM companies c
      LEFT JOIN subscriptions s ON s.company_id = c.id
        AND s.status IN ('active', 'trial')
      WHERE c.id = ${companyId}
      LIMIT 1
    `;
    const planId: string | null = (companyRow?.plan_id as string | null) ?? null;

    const rows = await sql`
      SELECT *
      FROM system_announcements
      WHERE starts_at <= NOW()
        AND (ends_at IS NULL OR ends_at >= NOW())
        AND (
          target = 'all'
          OR (target = 'company' AND ${companyId} = ANY(target_ids))
          OR (
            target = 'plan'
            AND ${planId}::uuid IS NOT NULL
            AND ${planId}::uuid = ANY(target_ids)
          )
        )
      ORDER BY starts_at DESC
    `;

    return apiResponse.success(res, rows.map(rowToAnnouncement));
  } catch (err) {
    log.error('Failed to fetch active announcements', { companyId, error: err }, 'announcements-api');
    return apiResponse.badRequest(res, 'Failed to fetch active announcements');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler) as any);
