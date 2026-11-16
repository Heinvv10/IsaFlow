/**
 * 13-week cash forecast: the company's salary pay day (migration 999i on payroll_company_settings,
 * service cashForecast13/payDaySetting). Set here until the payroll settings UI exists.
 * GET → { payDay, day, isDefault }: payDay { kind: 'day_of_month', day } | { kind: 'last_working_day' };
 *       no settings row = day 25 (isDefault). Any member.
 * PUT { kind: 'day_of_month', day: 1-31 } | { kind: 'last_working_day' } → 200 the same shape.
 *     A day beyond the month's length means the month's last day; last_working_day keeps the stored day.
 * Writes: owner/admin/manager + CSRF; a Login-as session is refused (403) before any write; one audit row
 * (entity_type 'payroll_company_settings') per write, in the request transaction.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { PayDayInput } from '@/modules/accounting/services/cashForecast13/storeSchemas';
import { getPayDay, setPayDay } from '@/modules/accounting/services/cashForecast13/payDaySetting';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET') return apiResponse.success(res, await getPayDay(companyId));
    if (method === 'PUT') {
      const parsed = PayDayInput.safeParse(req.body ?? {});
      if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request', parsed.error.flatten().fieldErrors);
      return apiResponse.success(res, await setPayDay(companyId, userId, parsed.data), 'Pay day saved');
    }
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    throw err;
  }
  return apiResponse.methodNotAllowed(res, method, ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
