/**
 * Company Details API — returns company profile for client-side PDF generation.
 * GET /api/accounting/company-details
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const rows = (await sql`
      SELECT
        name, email, phone, vat_number,
        address_line1, address_line2, city, province, postal_code,
        bank_name, bank_account_number, bank_branch_code,
        primary_color, logo_data
      FROM companies
      WHERE id = ${companyId}::UUID
      LIMIT 1
    `) as Row[];

    if (rows.length === 0) {
      return apiResponse.success(res, { name: '', email: '', phone: '', vat_number: '', address: '', primary_color: '#0d9488' });
    }

    const c = rows[0]!;
    const addressParts = [c.address_line1, c.address_line2, c.city, c.province, c.postal_code]
      .filter(Boolean).map(String);

    return apiResponse.success(res, {
      name: c.name ? String(c.name) : '',
      email: c.email ? String(c.email) : '',
      phone: c.phone ? String(c.phone) : '',
      vat_number: c.vat_number ? String(c.vat_number) : '',
      address: addressParts.join(', '),
      address_line1: c.address_line1 ? String(c.address_line1) : '',
      city: c.city ? String(c.city) : '',
      province: c.province ? String(c.province) : '',
      postal_code: c.postal_code ? String(c.postal_code) : '',
      bank_name: c.bank_name ? String(c.bank_name) : '',
      bank_account_number: c.bank_account_number ? String(c.bank_account_number) : '',
      bank_branch_code: c.bank_branch_code ? String(c.bank_branch_code) : '',
      primary_color: c.primary_color ? String(c.primary_color) : '#0d9488',
      logo_data: c.logo_data ? String(c.logo_data) : null,
    });
  } catch (err) {
    log.error('Failed to fetch company details', { error: err }, 'company-details-api');
    return apiResponse.internalError(res, err, 'Failed to fetch company details');
  }
}

export default withCompany(withErrorHandler(handler));
