/**
 * Customer Invoice Detail API
 * GET  ?id=UUID — single invoice with line items
 * PUT  { id, ...fields } — update draft invoice
 * POST { id, action } — status actions (approve, send, cancel)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return apiResponse.badRequest(res, 'id is required');

    const rows = (await sql`
      SELECT ci.*, c.company_name AS client_name, p.project_name
      FROM customer_invoices ci
      LEFT JOIN clients c ON c.id = ci.client_id
      LEFT JOIN projects p ON p.id = ci.project_id
      WHERE ci.id = ${id as string}::UUID
    `) as Row[];
    if (rows.length === 0) return apiResponse.notFound(res, 'Invoice', id as string);

    const items = (await sql`
      SELECT * FROM customer_invoice_items WHERE invoice_id = ${id as string}::UUID ORDER BY created_at
    `) as Row[];

    return apiResponse.success(res, { ...rows[0], items });
  }

  if (req.method === 'PUT') {
    const { id, notes, internalNotes, dueDate } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');

    await sql`
      UPDATE customer_invoices
      SET notes = COALESCE(${notes || null}, notes),
          internal_notes = COALESCE(${internalNotes || null}, internal_notes),
          due_date = COALESCE(${dueDate || null}, due_date),
          updated_at = NOW()
      WHERE id = ${id}::UUID AND status = 'draft'
    `;
    log.info('Customer invoice updated', { id });
    return apiResponse.success(res, { updated: true });
  }

  if (req.method === 'POST') {
    const { id, action } = req.body;
    if (!id || !action) return apiResponse.badRequest(res, 'id and action required');

    const validActions: Record<string, string> = {
      approve: 'approved', send: 'sent', cancel: 'cancelled',
    };
    const newStatus = validActions[action];
    if (!newStatus) return apiResponse.badRequest(res, `Unknown action: ${action}`);

    await sql`UPDATE customer_invoices SET status = ${newStatus}, updated_at = NOW() WHERE id = ${id}::UUID`;
    log.info('Customer invoice action', { id, action, newStatus });
    return apiResponse.success(res, { id, status: newStatus });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
