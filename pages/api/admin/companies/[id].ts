/**
 * Admin Company Detail API
 * GET    /api/admin/companies/[id] — Get company details
 * PATCH  /api/admin/companies/[id] — Update company fields
 * DELETE /api/admin/companies/[id] — Delete company
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  getCompanyDetail,
  updateCompany,
  deleteCompany,
} from '@/modules/admin/services/adminCompanyService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

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
    try {
      const {
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
      } = req.body as Record<string, string | undefined>;

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
        { fields: Object.keys(req.body as object) },
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

export default withAdmin(handler);
