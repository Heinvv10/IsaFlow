/**
 * Budget controls (budgets P5 spec §4, decisions 8/9).
 * GET → { settings: { checkPolicy, alertEmailEnabled, defaultThresholds, updatedAt }, overrides,
 *         emailAllowedOnServer, lastEvaluated }. Write roles (owner, admin, manager).
 * PUT { checkPolicy?: 'off'|'warn'|'block', defaultThresholds?: number[], alertEmailEnabled?: boolean }
 *   → the same view as GET, after the save. Owner or admin, CSRF. Thresholds: 1-5 whole percentages 1-999 (stored
 *   sorted, without duplicates). The email flag cannot be switched on while the server's
 *   BUDGET_ALERT_EMAIL_ENABLED is not 1 (409). Threshold overrides: ./thresholds.
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, DEFAULT_WRITE_ROLES, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondBudgetControlsError } from '@/lib/budgetControlsResponse';
import { CHECK_POLICIES, saveControlSettings, type CheckPolicy } from '@/modules/accounting/services/budgets/budgetControlSettings';
import { readControlsView } from '@/modules/accounting/services/budgets/budgetControlsApi';
import { ThresholdsSchema } from '@/modules/accounting/services/budgets/budgetControlSchemas';

const SettingsSchema = z.object({
  checkPolicy: z.enum(CHECK_POLICIES as [string, ...string[]]).optional(),
  defaultThresholds: ThresholdsSchema.optional(),
  alertEmailEnabled: z.boolean().optional(),
}).strict().refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const role = companyRole ?? '';
  if (req.method === 'GET') {
    if (!(DEFAULT_WRITE_ROLES as readonly string[]).includes(role)) {
      return apiResponse.forbidden(res, 'Your role does not allow viewing budget controls.');
    }
    return apiResponse.success(res, await readControlsView(companyId));
  }
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'PUT']);
  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  try {
    const { checkPolicy, defaultThresholds, alertEmailEnabled } = parsed.data;
    await saveControlSettings(companyId, userId, { checkPolicy: checkPolicy as CheckPolicy | undefined, defaultThresholds, alertEmailEnabled });
    return apiResponse.success(res, await readControlsView(companyId));
  } catch (err) {
    if (respondBudgetControlsError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
