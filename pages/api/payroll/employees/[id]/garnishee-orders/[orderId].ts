/**
 * POST /api/payroll/employees/[id]/garnishee-orders/[orderId]  { endDate, reason }  end a garnishee order (wave 6 GA).
 *
 * Runs whose period starts after `endDate` no longer deduct (the end date is the order's last day); a run that already deducted keeps its deduction, and its
 * approval still moves the balance. Payroll-detail roles, a person's own session, never Login-as. Judged before any
 * write: another company's order is 404, an ended one 409. Every response is no-store; the log masks the reason.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { EndOrderBody, GARNISHEE_LOG_MASK, garnisheeWriter, respondIfGarnisheeRefused, UUID } from '@/lib/payrollGarnisheeApi';
import { endGarnisheeOrder } from '@/modules/accounting/services/payroll/payrollGarnisheeOrders';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const { id, orderId } = req.query;
  if (typeof id !== 'string' || !UUID.test(id) || typeof orderId !== 'string' || !UUID.test(orderId)) {
    return apiResponse.badRequest(res, 'id and orderId must be UUIDs');
  }
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const actor = await garnisheeWriter(req, res);
  if (!actor) return;
  const parsed = EndOrderBody.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'endDate and reason are required');
  try {
    return apiResponse.success(res, await endGarnisheeOrder(companyId, id, orderId, parsed.data, actor));
  } catch (err) {
    if (respondIfLockTimeout(res, err) || respondIfGarnisheeRefused(res, err)) return;
    throw err;
  }
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)), { maskBodyKeys: GARNISHEE_LOG_MASK })));
