/**
 * Customer Delivery Addresses API
 * GET    ?customerId=X  — list delivery addresses for a customer
 * POST                  — create a new delivery address
 * DELETE ?id=X          — delete a delivery address
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

interface CreateBody {
  customerId: string;
  addressName: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
  isDefault?: boolean;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  // ─── GET: List delivery addresses for a customer ────────────────────────────
  if (req.method === 'GET') {
    const { customerId } = req.query;
    if (!customerId || typeof customerId !== 'string') {
      return apiResponse.badRequest(res, 'customerId is required');
    }

    try {
      const rows = (await sql`
        SELECT
          id, customer_id, address_name, address_line1, address_line2,
          city, province, postal_code, country, is_default, created_at, updated_at
        FROM customer_delivery_addresses
        WHERE customer_id = ${customerId}
          AND company_id = ${companyId}
        ORDER BY is_default DESC, address_name ASC
      `) as Row[];

      return apiResponse.success(res, rows);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('does not exist')) return apiResponse.success(res, []);
      log.error('customer-delivery-addresses GET failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to fetch delivery addresses');
    }
  }

  // ─── POST: Create delivery address ─────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body as CreateBody;
    const { customerId, addressName } = body;

    if (!customerId?.trim()) return apiResponse.badRequest(res, 'customerId is required');
    if (!addressName?.trim()) return apiResponse.badRequest(res, 'addressName is required');

    const s = (v: string | undefined) => (v?.trim() || null);
    const isDefault = body.isDefault === true;

    try {
      // If marking as default, clear existing default first
      if (isDefault) {
        await sql`
          UPDATE customer_delivery_addresses
          SET is_default = false
          WHERE customer_id = ${customerId} AND company_id = ${companyId}
        `;
      }

      const rows = (await sql`
        INSERT INTO customer_delivery_addresses (
          customer_id, company_id, address_name,
          address_line1, address_line2, city, province,
          postal_code, country, is_default
        ) VALUES (
          ${customerId}, ${companyId}, ${addressName.trim()},
          ${s(body.addressLine1)}, ${s(body.addressLine2)},
          ${s(body.city)}, ${s(body.province)},
          ${s(body.postalCode)}, ${s(body.country) ?? 'South Africa'},
          ${isDefault}
        )
        RETURNING *
      `) as Row[];

      log.info('Delivery address created', { id: rows[0]?.id, customerId, module: 'accounting' });
      return apiResponse.success(res, rows[0]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customer-delivery-addresses POST failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to create delivery address');
    }
  }

  // ─── DELETE: Remove delivery address ───────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id || typeof id !== 'string') return apiResponse.badRequest(res, 'id is required');

    try {
      await sql`
        DELETE FROM customer_delivery_addresses
        WHERE id = ${id} AND company_id = ${companyId}
      `;
      return apiResponse.success(res, { deleted: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('customer-delivery-addresses DELETE failed', { error: message, module: 'accounting' });
      return apiResponse.internalError(res, err, 'Failed to delete delivery address');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withCompany(withErrorHandler(withWriteAccess(handler as never)));
