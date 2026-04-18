/**
 * Supplier Activities API
 * GET    ?supplierId=X[&limit=50]  — list activities (newest first) with creator info
 * POST                             — create a new activity (created_by = authenticated user)
 * DELETE ?id=X                    — delete activity (own or admin/owner/manager role)
 */

import type { NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

type ActivityType =
  | 'note'
  | 'call'
  | 'email_sent'
  | 'email_received'
  | 'payment_made'
  | 'invoice_received'
  | 'status_change';

const VALID_ACTIVITY_TYPES = new Set<ActivityType>([
  'note', 'call', 'email_sent', 'email_received',
  'payment_made', 'invoice_received', 'status_change',
]);

interface CreateBody {
  supplierId: string;
  activity_type: ActivityType;
  subject?: string;
  description: string;
}

function isActivityType(v: unknown): v is ActivityType {
  return typeof v === 'string' && VALID_ACTIVITY_TYPES.has(v as ActivityType);
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId, user } = req;

  // ─── GET: List activities for a supplier ───────────────────────────────────
  if (req.method === 'GET') {
    const { supplierId, limit } = req.query;
    if (!supplierId || typeof supplierId !== 'string') {
      return apiResponse.badRequest(res, 'supplierId is required');
    }

    const limitNum = Math.min(parseInt(typeof limit === 'string' ? limit : '50', 10) || 50, 200);

    try {
      const rows = (await sql`
        SELECT
          sa.id,
          sa.supplier_id,
          sa.activity_type,
          sa.subject,
          sa.description,
          sa.created_at,
          sa.created_by,
          u.email        AS created_by_email,
          u.first_name   AS created_by_first_name,
          u.last_name    AS created_by_last_name
        FROM supplier_activities sa
        LEFT JOIN users u ON u.id = sa.created_by
        WHERE sa.supplier_id = ${supplierId}
          AND sa.company_id  = ${companyId}
        ORDER BY sa.created_at DESC
        LIMIT ${limitNum}
      `) as Row[];

      return apiResponse.success(res, rows);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('does not exist')) return apiResponse.success(res, []);
      log.error('supplier-activities GET failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to fetch activities');
    }
  }

  // ─── POST: Create activity ─────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body as CreateBody;
    const { supplierId, activity_type, description } = body;

    if (!supplierId?.trim()) return apiResponse.badRequest(res, 'supplierId is required');
    if (!isActivityType(activity_type)) {
      return apiResponse.badRequest(
        res,
        `activity_type must be one of: ${[...VALID_ACTIVITY_TYPES].join(', ')}`,
      );
    }
    if (!description?.trim()) return apiResponse.badRequest(res, 'description is required');

    const subject = body.subject?.trim() || null;

    try {
      const rows = (await sql`
        INSERT INTO supplier_activities (
          supplier_id, company_id, activity_type, subject, description, created_by
        ) VALUES (
          ${supplierId}, ${companyId}, ${activity_type}, ${subject}, ${description.trim()}, ${user.id}
        )
        RETURNING *
      `) as Row[];

      log.info('Supplier activity created', {
        id: rows[0]?.id,
        supplierId,
        activity_type,
        module: 'accounting',
      });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('supplier-activities POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create activity');
    }
  }

  // ─── DELETE: Remove activity ───────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id || typeof id !== 'string') return apiResponse.badRequest(res, 'id is required');

    const isPrivileged = ['owner', 'admin', 'manager'].includes(req.companyRole);

    try {
      const result = isPrivileged
        ? (await sql`
            DELETE FROM supplier_activities
            WHERE id = ${id} AND company_id = ${companyId}
            RETURNING id
          `) as Row[]
        : (await sql`
            DELETE FROM supplier_activities
            WHERE id = ${id} AND company_id = ${companyId} AND created_by = ${user.id}
            RETURNING id
          `) as Row[];

      if (result.length === 0) {
        return apiResponse.forbidden(res, 'Activity not found or you do not have permission to delete it');
      }

      return apiResponse.success(res, { deleted: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('supplier-activities DELETE failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to delete activity');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
