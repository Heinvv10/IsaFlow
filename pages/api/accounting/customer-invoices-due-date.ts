/**
 * PUT /api/accounting/customer-invoices-due-date  { id, dueDate }
 * Change the due date of an open (approved, sent, overdue or part-paid) customer invoice, and nothing else
 * (payment-terms programme, AR parity with supplier-invoices-due-date). The change is recorded in the entity history
 * by the database (migration 962); the response says what it was.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { InvoiceDueDateEditRefusal, setOpenInvoiceDueDate } from '@/modules/accounting/services/ar/invoiceDueDateEdit';
import { CustomerInvoiceLockTimeoutError } from '@/modules/accounting/services/ar/customerInvoiceLock';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['PUT']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => k !== 'id' && k !== 'dueDate');
  // Date only: a body naming anything else is refused, not partly applied.
  if (extra.length > 0) return apiResponse.badRequest(res, `Only the due date can be changed here (refused: ${extra.join(', ')})`);
  if (typeof body.id !== 'string' || !UUID.test(body.id)) return apiResponse.badRequest(res, 'id must be a customer invoice id');
  try {
    const result = await setOpenInvoiceDueDate(companyId, body.id, body.dueDate);
    if (result.changed) {
      log.info('Customer invoice due date changed', {
        id: result.id, from: result.previousDueDate, to: result.dueDate, userId: user.id,
      }, 'accounting-api');
    }
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof InvoiceDueDateEditRefusal) {
      if (err.status === 404) return apiResponse.notFound(res, 'Invoice', body.id);
      return err.status === 409 ? apiResponse.conflict(res, err.message) : apiResponse.badRequest(res, err.message);
    }
    if (err instanceof CustomerInvoiceLockTimeoutError) return apiResponse.conflict(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
