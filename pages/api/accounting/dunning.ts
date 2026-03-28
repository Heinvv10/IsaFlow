/**
 * Dunning Communications API
 * GET: List dunning communications (optionally filter by client_id)
 * POST: Create a new dunning communication
 * PUT: Update status (e.g. mark as sent)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export default withCompany(withErrorHandler(async (req: NextApiRequest, res: NextApiResponse) => {
  const { companyId } = req as CompanyApiRequest;

  switch (req.method) {
    case 'GET': {
      const { client_id, status: filterStatus, limit: limitStr } = req.query;
      const rowLimit = Math.min(parseInt(limitStr as string, 10) || 100, 500);

      if (client_id) {
        const rows = (await sql`
          SELECT dc.*, c.name as client_name,
                 u.first_name || ' ' || u.last_name as created_by_name
          FROM dunning_communications dc
          JOIN customers c ON c.id = dc.client_id
          LEFT JOIN users u ON u.id = dc.created_by
          WHERE dc.client_id = ${client_id as string}
            AND c.company_id = ${companyId}
          ORDER BY dc.created_at DESC
          LIMIT ${rowLimit}
        `) as Row[];
        return apiResponse.success(res, rows);
      }

      if (filterStatus) {
        const rows = (await sql`
          SELECT dc.*, c.name as client_name,
                 u.first_name || ' ' || u.last_name as created_by_name
          FROM dunning_communications dc
          JOIN customers c ON c.id = dc.client_id
          LEFT JOIN users u ON u.id = dc.created_by
          WHERE dc.status = ${filterStatus as string}
            AND c.company_id = ${companyId}
          ORDER BY dc.created_at DESC
          LIMIT ${rowLimit}
        `) as Row[];
        return apiResponse.success(res, rows);
      }

      const rows = (await sql`
        SELECT dc.*, c.name as client_name,
               u.first_name || ' ' || u.last_name as created_by_name
        FROM dunning_communications dc
        JOIN customers c ON c.id = dc.client_id
        LEFT JOIN users u ON u.id = dc.created_by
        WHERE c.company_id = ${companyId}
        ORDER BY dc.created_at DESC
        LIMIT ${rowLimit}
      `) as Row[];
      return apiResponse.success(res, rows);
    }

    case 'POST': {
      const {
        client_id, type = 'reminder', level = 1,
        subject, body, total_overdue = 0,
        invoices_included = [], sent_via = 'email', sent_to
      } = req.body;

      if (!client_id || !subject || !body) {
        return apiResponse.badRequest(res, 'client_id, subject, and body are required');
      }

      const userId = (req as NextApiRequest & { user?: { id: string } }).user?.id || null;

      const rows = (await sql`
        INSERT INTO dunning_communications (
          client_id, type, level, subject, body, total_overdue,
          invoices_included, sent_via, sent_to, status, created_by
        ) VALUES (
          ${client_id}, ${type}, ${level}, ${subject}, ${body},
          ${total_overdue}, ${invoices_included}, ${sent_via},
          ${sent_to || null}, 'draft', ${userId}
        )
        RETURNING *
      `) as Row[];

      log.info('Dunning communication created', { client_id, type, level }, 'accounting');
      return apiResponse.success(res, rows[0], 'Communication created', 201);
    }

    case 'PUT': {
      const { id, status: newStatus, sent_at } = req.body;
      if (!id) return apiResponse.badRequest(res, 'id is required');

      const rows = (await sql`
        UPDATE dunning_communications
        SET status = COALESCE(${newStatus || null}, status),
            sent_at = COALESCE(${sent_at || null}, sent_at)
        WHERE id = ${id}
        RETURNING *
      `) as Row[];
      if (rows.length === 0) return apiResponse.notFound(res, 'Communication', id);
      return apiResponse.success(res, rows[0]);
    }

    default:
      return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT']);
  }
}));
