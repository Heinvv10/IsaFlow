/**
 * GET  /api/payroll/employees/[id]/garnishee-orders  the employee's garnishee orders (wave 6 GA), newest first.
 * POST /api/payroll/employees/[id]/garnishee-orders  { kind, reference, creditorName, instalment, totalDebt, startDate,
 *                                                     endDate, priority }  enter an order.
 *
 * Payroll-detail roles (owner, admin, manager). POST: a person's own session, never Login-as (payrollGarnisheeApi).
 * Judged before any write; a company's first order also creates its garnishee payable account (payrollGarnisheeAccount).
 * Another company's employee is 404. Every response is no-store. The request log masks the order (GARNISHEE_LOG_MASK).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { CreateOrderBody, GARNISHEE_LOG_MASK, garnisheeWriter, respondIfGarnisheeRefused, UUID } from '@/lib/payrollGarnisheeApi';
import { createGarnisheeOrder, listGarnisheeOrders } from '@/modules/accounting/services/payroll/payrollGarnisheeOrders';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (req.method === 'GET') {
    const orders = await listGarnisheeOrders(companyId, id);
    return orders ? apiResponse.success(res, { orders }) : apiResponse.notFound(res, 'PayrollEmployee', id);
  }
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
  const actor = await garnisheeWriter(req, res);
  if (!actor) return;
  const parsed = CreateOrderBody.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid garnishee order');
  try {
    return apiResponse.created(res, await createGarnisheeOrder(companyId, id, parsed.data, actor));
  } catch (err) {
    if (respondIfLockTimeout(res, err) || respondIfGarnisheeRefused(res, err)) return;
    throw err;
  }
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)), { maskBodyKeys: GARNISHEE_LOG_MASK })));
