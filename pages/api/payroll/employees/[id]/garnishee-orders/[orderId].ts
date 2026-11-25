/**
 * POST /api/payroll/employees/[id]/garnishee-orders/[orderId]  { endDate, reason }  end a garnishee order (wave 6 GA).
 *
 * Runs whose period starts after `endDate` no longer deduct (the end date is the order's last day); a run that already deducted keeps its deduction, and its
 * approval still moves the balance. Payroll-detail roles, a person's own session, never Login-as. Judged before any
 * write: another company's order is 404, an ended one 409. Every response is no-store; the log masks the reason.
 *
 * GET  ...[orderId]  the creditor's bank details on the order (wave 7 GC1), or null: in full for owner / admin (recorded
 *      in audit_log, `export`), else masked; `?view=masked` asks for the masked view whatever the role.
 * PUT  ...[orderId]  { bankName, branchCode, accountNumber, accountType, accountHolder? }  enter them (any payroll-detail
 *      role) or change them (owner / admin only: 403 CHANGE_REQUIRES_ADMIN); answers the masked view. Invalid is 422.
 * GET and PUT: a person's own session only, never Login-as or a token (garnisheeWriter). The log masks every bank field.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { CREDITOR_BANK_KEYS, EndOrderBody, GARNISHEE_LOG_MASK, garnisheeWriter, respondIfGarnisheeRefused, UUID } from '@/lib/payrollGarnisheeApi';
import { parseBankDetailsInput, PayrollBankDetailsRefusal } from '@/modules/accounting/services/payroll/payrollBankDetailsService';
import { CreditorBankRefusal, getCreditorBank, setCreditorBank } from '@/modules/accounting/services/payroll/payrollGarnisheeCreditorBank';
import { endGarnisheeOrder } from '@/modules/accounting/services/payroll/payrollGarnisheeOrders';
import { withPayrollModule } from '@/lib/auth/withPayrollModule';

function respondIfCreditorBankRefused(res: NextApiResponse, err: unknown): boolean {
  if (err instanceof PayrollBankDetailsRefusal && err.code === 'INVALID') {
    apiResponse.validationError(res, err.fieldErrors ?? {});
    return true;
  }
  if (!(err instanceof CreditorBankRefusal)) return false;
  if (err.code === 'ORDER_NOT_FOUND') apiResponse.error(res, ErrorCode.NOT_FOUND, err.message, { reason: err.code });
  else apiResponse.error(res, ErrorCode.FORBIDDEN, err.message, { reason: err.code });
  return true;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const { id, orderId } = req.query;
  if (typeof id !== 'string' || !UUID.test(id) || typeof orderId !== 'string' || !UUID.test(orderId)) {
    return apiResponse.badRequest(res, 'id and orderId must be UUIDs');
  }
  if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'PUT') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PUT']);
  }
  const actor = await garnisheeWriter(req, res);
  if (!actor) return;
  try {
    if (req.method === 'GET') {
      return apiResponse.success(res, await getCreditorBank(companyId, id, orderId, companyRole, req.query.view === 'masked', actor));
    }
    if (req.method === 'PUT') {
      const body: unknown = req.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some((k) => !CREDITOR_BANK_KEYS.has(k))) {
        return apiResponse.badRequest(res, `The body takes ${[...CREDITOR_BANK_KEYS].join(', ')} only`);
      }
      const input = parseBankDetailsInput(body);
      return apiResponse.success(res, await setCreditorBank(companyId, id, orderId, input, companyRole, actor));
    }
    const parsed = EndOrderBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'endDate and reason are required');
    return apiResponse.success(res, await endGarnisheeOrder(companyId, id, orderId, parsed.data, actor));
  } catch (err) {
    if (respondIfLockTimeout(res, err) || respondIfGarnisheeRefused(res, err) || respondIfCreditorBankRefused(res, err)) return;
    throw err;
  }
}

export default withAuth(withNoStore(withErrorHandler(withPayrollModule(withCsrf(withPayrollDetailAccess(handler))), { maskBodyKeys: GARNISHEE_LOG_MASK })));
