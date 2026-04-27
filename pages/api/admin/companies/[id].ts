/**
 * Admin Company Detail API
 * GET    /api/admin/companies/[id] — Get company details
 * PATCH  /api/admin/companies/[id] — Update company fields
 * DELETE /api/admin/companies/[id] — Delete company
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  getCompanyDetail,
  updateCompany,
  deleteCompany,
} from '@/modules/admin/services/adminCompanyService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { Email } from '@/lib/schemas/common';

const PatchBody = z.object({
  name:            z.string().min(1).max(200).optional(),
  trading_name:    z.string().max(200).optional(),
  phone:           z.string().max(30).optional(),
  email:           Email.optional(),
  website:         z.string().url().optional(),
  billing_email:   Email.optional(),
  billing_contact: z.string().max(100).optional(),
  address_line1:   z.string().max(200).optional(),
  city:            z.string().max(100).optional(),
  province:        z.string().max(100).optional(),
  postal_code:     z.string().max(20).optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = req.query.id as string;

  if (req.method === 'GET') {
    try {
      const company = await getCompanyDetail(companyId);
      if (!company) {
        return apiResponse.notFound(res, 'Company', companyId);
      }
      return apiResponse.success(res, company);
    } catch (err) {
      log.error('Failed to get company detail', { companyId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get company detail');
    }
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { name, trading_name, phone, email, website, billing_email, billing_contact, address_line1, city, province, postal_code } = parsed.data;

      await updateCompany(companyId, {
        name,
        trading_name,
        phone,
        email,
        website,
        billing_email,
        billing_contact,
        address_line1,
        city,
        province,
        postal_code,
      });

      const updated = await getCompanyDetail(companyId);
      if (!updated) {
        return apiResponse.notFound(res, 'Company', companyId);
      }

      await logAdminAction(
        req.user.id,
        'company.update',
        'company',
        companyId,
        { fields: Object.keys(parsed.data) },
        getIp(req)
      );

      return apiResponse.success(res, updated);
    } catch (err) {
      log.error('Failed to update company', { companyId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to update company');
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteCompany(companyId);

      await logAdminAction(
        req.user.id,
        'company.delete',
        'company',
        companyId,
        null,
        getIp(req)
      );

      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      log.error('Failed to delete company', { companyId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to delete company');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(withCsrf(handler));
