/**
 * Supplier Contacts API
 * GET    ?supplierId=X  — list contacts for a supplier
 * POST                  — create a new contact
 * DELETE ?id=X          — delete a contact
 */

import type { NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

interface CreateBody {
  supplierId: string;
  fullName: string;
  role?: string;
  email?: string;
  phone?: string;
  isPrimary?: boolean;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  // ─── GET: List contacts for a supplier ─────────────────────────────────────
  if (req.method === 'GET') {
    const { supplierId } = req.query;
    if (!supplierId || typeof supplierId !== 'string') {
      return apiResponse.badRequest(res, 'supplierId is required');
    }

    try {
      const rows = (await sql`
        SELECT id, supplier_id, full_name, role, email, phone, is_primary, created_at
        FROM supplier_contacts
        WHERE supplier_id = ${supplierId}
          AND company_id  = ${companyId}
        ORDER BY is_primary DESC, full_name ASC
      `) as Row[];

      return apiResponse.success(res, rows);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('supplier-contacts GET failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to fetch contacts');
    }
  }

  // ─── POST: Create contact ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body as CreateBody;
    const { supplierId, fullName } = body;

    if (!supplierId?.trim()) return apiResponse.badRequest(res, 'supplierId is required');
    if (!fullName?.trim())   return apiResponse.badRequest(res, 'fullName is required');

    const s = (v: string | undefined) => (v?.trim() || null);
    const isPrimary = body.isPrimary === true;

    try {
      // If marking as primary, clear existing primary first
      if (isPrimary) {
        await sql`
          UPDATE supplier_contacts
          SET is_primary = false
          WHERE supplier_id = ${supplierId} AND company_id = ${companyId}
        `;
      }

      const rows = (await sql`
        INSERT INTO supplier_contacts (
          supplier_id, company_id, full_name, role, email, phone, is_primary
        ) VALUES (
          ${supplierId}, ${companyId}, ${fullName.trim()},
          ${s(body.role)}, ${s(body.email)}, ${s(body.phone)}, ${isPrimary}
        )
        RETURNING *
      `) as Row[];

      log.info('Supplier contact created', { id: rows[0]?.id, supplierId, module: 'accounting' });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('supplier-contacts POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create contact');
    }
  }

  // ─── DELETE: Remove contact ─────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id || typeof id !== 'string') return apiResponse.badRequest(res, 'id is required');

    try {
      await sql`
        DELETE FROM supplier_contacts
        WHERE id = ${id} AND company_id = ${companyId}
      `;
      return apiResponse.success(res, { deleted: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('supplier-contacts DELETE failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to delete contact');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
