/**
 * Customer Contacts API
 * GET    ?customerId=X  — list contacts for a customer
 * POST                  — create a new contact
 * DELETE ?id=X          — delete a contact
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';
import { assertCustomerInCompany, CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';

type Row = Record<string, unknown>;

interface CreateBody {
  customerId: string;
  fullName: string;
  role?: string;
  email?: string;
  phone?: string;
  isPrimary?: boolean;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  // ─── GET: List contacts for a customer ─────────────────────────────────────
  if (req.method === 'GET') {
    const { customerId } = req.query;
    if (!customerId || typeof customerId !== 'string') {
      return apiResponse.badRequest(res, 'customerId is required');
    }

    try {
      const rows = (await sql`
        SELECT id, customer_id, full_name, role, email, phone, is_primary, created_at
        FROM customer_contacts
        WHERE customer_id = ${customerId}
          AND company_id = ${companyId}
        ORDER BY is_primary DESC, full_name ASC
      `) as Row[];

      return apiResponse.success(res, rows);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customer-contacts GET failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to fetch contacts');
    }
  }

  // ─── POST: Create contact ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body as CreateBody;
    const { customerId, fullName } = body;

    if (!customerId?.trim()) return apiResponse.badRequest(res, 'customerId is required');
    if (!fullName?.trim()) return apiResponse.badRequest(res, 'fullName is required');

    const s = (v: string | undefined) => (v?.trim() || null);
    const isPrimary = body.isPrimary === true;

    // R-067: customerId comes from the request body. Checked before the first
    // write (withAuth COMMITs a 4xx returned after one).
    try {
      await assertCustomerInCompany(companyId, customerId);
    } catch (err) {
      if (err instanceof CustomerNotInCompanyError) return apiResponse.badRequest(res, err.message);
      throw err;
    }

    try {
      // If marking as primary, clear existing primary first
      if (isPrimary) {
        await sql`
          UPDATE customer_contacts
          SET is_primary = false
          WHERE customer_id = ${customerId} AND company_id = ${companyId}
        `;
      }

      const rows = (await sql`
        INSERT INTO customer_contacts (
          customer_id, company_id, full_name, role, email, phone, is_primary
        ) VALUES (
          ${customerId}, ${companyId}, ${fullName.trim()},
          ${s(body.role)}, ${s(body.email)}, ${s(body.phone)}, ${isPrimary}
        )
        RETURNING *
      `) as Row[];

      log.info('Customer contact created', { id: rows[0]?.id, customerId, module: 'accounting' });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customer-contacts POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create contact');
    }
  }

  // ─── DELETE: Remove contact ─────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id || typeof id !== 'string') return apiResponse.badRequest(res, 'id is required');

    try {
      await sql`
        DELETE FROM customer_contacts
        WHERE id = ${id} AND company_id = ${companyId}
      `;
      return apiResponse.success(res, { deleted: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customer-contacts DELETE failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to delete contact');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
