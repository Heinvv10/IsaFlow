/**
 * Companies API
 * GET  — list companies for current user
 * POST — action 'set-default' (creating a company is onboarding's: 400 here)
 * PUT  — update company details
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getCompany, updateCompany,
  getUserCompanies, setDefaultCompany,
} from '@/modules/accounting/services/core/companyService';
import { ENTITY_TYPE_CODES, isEntityTypeCode } from '@/lib/entityTypes';
import { isValidVatPeriod, isValidVatSystemType } from '@/modules/accounting/services/core/vatSettingValidation';
import { EntityTypeChangeRefused } from '@/modules/onboarding/services/entityTypeChange';
import {
  FinancialYearStartLockedError, FinancialYearStartScopeError, FiscalPeriodsInUseError,
  InvalidFinancialYearStartError, countPostedJournals,
} from '@/modules/accounting/services/gl/fiscalYearStartChange';

// Re-exported: tests and older imports name them from this route.
export { isValidVatPeriod, isValidVatSystemType };

/**
 * AUTH: Uses withAuth (not withAuth) because this endpoint manages the list of
 * companies a user belongs to — it is intentionally cross-company. All reads are scoped
 * to getUserCompanies(userId), which filters by the authenticated user's company_users
 * rows. Any access to a specific company (GET ?id=, PUT, POST set-default) is guarded by
 * a membership check verifying the user belongs to that company. Super-admin access to
 * arbitrary company records is explicitly gated on role === 'super_admin'.
 * See docs/audits/2026-04-14/04-code-quality.md#Q-005 for rationale.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    if (req.query.action === 'user-companies') {
      const companies = await getUserCompanies(userId);
      // The company withAuth scoped this request to (the active_company_id
      // cookie, membership-checked). CompanyProvider names this one, not its
      // localStorage copy — R-148.
      const activeCompanyId = (req as CompanyAuthedRequest).companyId;
      return apiResponse.success(res, { items: companies, activeCompanyId });
    }
    if (req.query.id) {
      // super_admin can access any company (impersonation / support access)
      const isSuperAdmin = (req as CompanyAuthedRequest).companyRole === 'super_admin';
      if (!isSuperAdmin) {
        const userCompanies = await getUserCompanies(userId);
        const hasAccess = userCompanies.some(c => c.companyId === req.query.id);
        if (!hasAccess) return apiResponse.forbidden(res, 'You do not have access to this company');
      } else {
        log.warn('super_admin company access bypass', {
          action: 'super_admin_company_access',
          userId,
          targetCompanyId: req.query.id as string,
          timestamp: new Date().toISOString(),
        }, 'audit');
      }
      const company = await getCompany(req.query.id as string);
      if (!company) return apiResponse.notFound(res, 'Company');
      // Settings shows the financial year start read-only once anything has posted (PUT refuses the change).
      const financialYearStartLocked = (await countPostedJournals(company.id)) > 0;
      return apiResponse.success(res, { ...company, financialYearStartLocked });
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
    // Creating a company here made a pty_ltd with no required proof and no
    // entity choice. Self-serve creation is POST /api/onboarding/complete-setup,
    // which enforces both. (Email verification's placeholder, admin create and
    // waitlist promotion still create companies with the DB default pty_ltd
    // and no proof: a known follow-up.) 400, not 405: POST stays allowed here
    // for action 'set-default'.
    return apiResponse.badRequest(res, 'Create a company through onboarding (/onboarding)');
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    if (!isValidVatPeriod(updates.vatPeriod)) {
      return apiResponse.badRequest(res, "vatPeriod must be 'monthly', 'bi-monthly' or 'none'");
    }
    if (!isValidVatSystemType(updates.vatSystemType)) {
      return apiResponse.badRequest(res, "vatSystemType must be 'invoice', 'payment' or 'none'");
    }
    if (updates.entityType !== undefined && !isEntityTypeCode(updates.entityType)) {
      return apiResponse.badRequest(res, `entityType must be one of: ${ENTITY_TYPE_CODES.join(', ')}`);
    }
    // Verify user is owner or admin of this company
    const userCompanies = await getUserCompanies(userId);
    const membership = userCompanies.find(c => c.companyId === id);
    if (!membership) return apiResponse.forbidden(res, 'You do not have access to this company');
    if (!['owner', 'admin'].includes(membership.role)) {
      return apiResponse.forbidden(res, 'Only owners and admins can update company details');
    }
    try {
      const company = await updateCompany(id, updates);
      return apiResponse.success(res, company);
    } catch (err) {
      // updateCompany checks a new entity type's proof (entityTypeChange.ts) before it writes.
      if (err instanceof EntityTypeChangeRefused) return apiResponse.badRequest(res, err.message, { issues: err.issues });
      // ...and a financial year start change (fiscalYearStartChange.ts), also before it writes.
      if (err instanceof FinancialYearStartLockedError) {
        return apiResponse.conflict(res, err.message, { postedJournals: err.postedJournals });
      }
      if (err instanceof FiscalPeriodsInUseError) return apiResponse.conflict(res, err.message, { references: err.references });
      if (err instanceof InvalidFinancialYearStartError || err instanceof FinancialYearStartScopeError) {
        return apiResponse.badRequest(res, err.message);
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(handler)));

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};
