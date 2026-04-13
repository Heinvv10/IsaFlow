/**
 * Companies API
 * GET  — list companies for current user
 * POST — create a new company
 * PUT  — update company details
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import {
  getCompany, createCompany, updateCompany,
  getUserCompanies, setDefaultCompany,
} from '@/modules/accounting/services/core/companyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    if (req.query.action === 'user-companies') {
      const companies = await getUserCompanies(userId);
      return apiResponse.success(res, { items: companies });
    }
    if (req.query.id) {
      // super_admin can access any company (impersonation / support access)
      const isSuperAdmin = (req as AuthenticatedNextApiRequest).user.role === 'super_admin';
      if (!isSuperAdmin) {
        const userCompanies = await getUserCompanies(userId);
        const hasAccess = userCompanies.some(c => c.companyId === req.query.id);
        if (!hasAccess) return apiResponse.forbidden(res, 'You do not have access to this company');
      }
      const company = await getCompany(req.query.id as string);
      if (!company) return apiResponse.notFound(res, 'Company');
      return apiResponse.success(res, company);
    }
    // Default: only return companies the user belongs to
    const companies = await getUserCompanies(userId);
    return apiResponse.success(res, { items: companies });
  }

  if (req.method === 'POST') {
    if (req.body.action === 'set-default') {
      // Verify membership before setting default
      const userCompanies = await getUserCompanies(userId);
      if (!userCompanies.some(c => c.companyId === req.body.companyId)) {
        return apiResponse.forbidden(res, 'You do not have access to this company');
      }
      await setDefaultCompany(userId, req.body.companyId);
      return apiResponse.success(res, { success: true });
    }
    const {
      name, tradingName, registrationNumber, vatNumber, taxNumber, email, phone,
      website, addressLine1, addressLine2, city, province, postalCode, country,
      logoData, bankName, bankAccountNumber, bankBranchCode, bankAccountType,
      financialYearStart, vatPeriod, defaultCurrency,
    } = req.body;
    if (!name) return apiResponse.badRequest(res, 'name is required');
    const company = await createCompany(
      {
        name, tradingName, registrationNumber, vatNumber, taxNumber, email, phone,
        website, addressLine1, addressLine2, city, province, postalCode, country,
        logoData, bankName, bankAccountNumber, bankBranchCode, bankAccountType,
        financialYearStart, vatPeriod, defaultCurrency,
      },
      userId
    );
    return apiResponse.success(res, company);
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    // Verify user is owner or admin of this company
    const userCompanies = await getUserCompanies(userId);
    const membership = userCompanies.find(c => c.companyId === id);
    if (!membership) return apiResponse.forbidden(res, 'You do not have access to this company');
    if (!['owner', 'admin'].includes(membership.role)) {
      return apiResponse.forbidden(res, 'Only owners and admins can update company details');
    }
    const company = await updateCompany(id, updates);
    return apiResponse.success(res, company);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT']);
}

 
export default withAuth(withErrorHandler(handler));

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};
