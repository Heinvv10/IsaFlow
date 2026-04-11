/**
 * Customer Activities API
 * GET    ?customerId=X[&limit=50]  — list activities (newest first) with creator info
 * POST                             — create a new activity (created_by = authenticated user)
 * DELETE ?id=X                    — delete activity (own activities or admin/owner role)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

type ActivityType =
  | 'note'
  | 'call'
  | 'email_sent'
  | 'email_received'
  | 'payment_received'
  | 'invoice_sent'
  | 'status_change';

const VALID_ACTIVITY_TYPES = new Set<ActivityType>([
  'note', 'call', 'email_sent', 'email_received',
  'payment_received', 'invoice_sent', 'status_change',
]);

interface CreateBody {
  customerId: string;
  activity_type: ActivityType;
  subject?: string;
  description: string;
}

function isActivityType(v: unknown): v is ActivityType {
  return typeof v === 'string' && VALID_ACTIVITY_TYPES.has(v as ActivityType);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyApiRequest;

  // ─── GET: List activities for a customer ───────────────────────────────────
  if (req.method === 'GET') {
    const { customerId, limit } = req.query;
    if (!customerId || typeof customerId !== 'string') {
      return apiResponse.badRequest(res, 'customerId is required');
    }

    const limitNum = Math.min(parseInt(typeof limit === 'string' ? limit : '50', 10) || 50, 200);

    try {
      const rows = (await sql`
        SELECT
          ca.id,
          ca.customer_id,
          ca.activity_type,
          ca.subject,
          ca.description,
          ca.created_at,
          ca.created_by,
          u.email        AS created_by_email,
          u.first_name   AS created_by_first_name,
          u.last_name    AS created_by_last_name
        FROM customer_activities ca
        LEFT JOIN users u ON u.id = ca.created_by
        WHERE ca.customer_id = ${customerId}
          AND ca.company_id  = ${companyId}
        ORDER BY ca.created_at DESC
        LIMIT ${limitNum}
      `) as Row[];

      return apiResponse.success(res, rows);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('does not exist')) return apiResponse.success(res, []);
      log.error('customer-activities GET failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to fetch activities');
    }
  }

  // ─── POST: Create activity ─────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body as CreateBody;
    const { customerId, activity_type, description } = body;

    if (!customerId?.trim()) return apiResponse.badRequest(res, 'customerId is required');
    if (!isActivityType(activity_type)) {
      return apiResponse.badRequest(res, `activity_type must be one of: ${[...VALID_ACTIVITY_TYPES].join(', ')}`);
    }
    if (!description?.trim()) return apiResponse.badRequest(res, 'description is required');

    const subject = body.subject?.trim() || null;

    try {
      const rows = (await sql`
        INSERT INTO customer_activities (
          customer_id, company_id, activity_type, subject, description, created_by
        ) VALUES (
          ${customerId}, ${companyId}, ${activity_type}, ${subject}, ${description.trim()}, ${user.id}
        )
        RETURNING *
      `) as Row[];

      log.info('Customer activity created', {
        id: rows[0]?.id,
        customerId,
        activity_type,
        module: 'accounting',
      });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customer-activities POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create activity');
    }
  }

  // ─── DELETE: Remove activity ───────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id || typeof id !== 'string') return apiResponse.badRequest(res, 'id is required');

    const companyReq = req as CompanyApiRequest;
    const isPrivileged = ['owner', 'admin', 'manager'].includes(companyReq.companyRole);

    try {
      // Owners/admins/managers may delete any activity; others only their own.
      const result = isPrivileged
        ? (await sql`
            DELETE FROM customer_activities
            WHERE id = ${id} AND company_id = ${companyId}
            RETURNING id
          `) as Row[]
        : (await sql`
            DELETE FROM customer_activities
            WHERE id = ${id} AND company_id = ${companyId} AND created_by = ${user.id}
            RETURNING id
          `) as Row[];

      if (result.length === 0) {
        return apiResponse.forbidden(res, 'Activity not found or you do not have permission to delete it');
      }

      return apiResponse.success(res, { deleted: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customer-activities DELETE failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to delete activity');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withCompany(withErrorHandler(withWriteAccess(handler as never)));
