/**
 * Delivery Notes API
 * GET    — list delivery notes (status filter, pagination)
 * GET    — single note (?id=UUID)
 * POST   — create new delivery note
 * PATCH  — update status
 * DELETE — soft-delete (cancel)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withWriteAccess,
  type CompanyAuthedRequest,
  type AuthenticatedNextApiRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getDeliveryNotes,
  getDeliveryNote,
  createDeliveryNote,
  updateDeliveryNoteStatus,
  cancelDeliveryNote,
  type DeliveryNoteInput,
} from '@/modules/accounting/services/ar/deliveryNoteService';
import { log } from '@/lib/logger';
import { CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { id, status, limit, offset } = req.query;

    if (id) {
      const note = await getDeliveryNote(companyId, id as string);
      if (!note) return apiResponse.notFound(res, 'Delivery Note', id as string);
      return apiResponse.success(res, note);
    }

    const result = await getDeliveryNotes(companyId, {
      status: status as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const userId = String(req.user.id);
    const input = req.body as DeliveryNoteInput;

    if (!input.customer_id) return apiResponse.badRequest(res, 'customer_id is required');
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      return apiResponse.badRequest(res, 'At least one line item is required');
    }
    const validLines = input.lines.filter((l) => l.description?.trim());
    if (validLines.length === 0) {
      return apiResponse.badRequest(res, 'At least one line with a description is required');
    }

    log.info('Creating delivery note', { companyId, customerId: input.customer_id });
    try {
      const note = await createDeliveryNote(companyId, { ...input, lines: validLines }, userId);
      return apiResponse.created(res, note);
    } catch (err) {
      // Thrown before the note number is reserved, so nothing has been written.
      if (err instanceof CustomerNotInCompanyError) return apiResponse.badRequest(res, err.message);
      throw err;
    }
  }

  if (req.method === 'PATCH') {
    const { id, status } = req.body as { id?: string; status?: string };
    if (!id) return apiResponse.badRequest(res, 'id is required');
    if (!status) return apiResponse.badRequest(res, 'status is required');

    const allowed = ['draft', 'dispatched', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) {
      return apiResponse.badRequest(res, `status must be one of: ${allowed.join(', ')}`);
    }

    log.info('Updating delivery note status', { companyId, id, status });
    const note = await updateDeliveryNoteStatus(companyId, id, status);
    if (!note) return apiResponse.notFound(res, 'Delivery Note', id);
    return apiResponse.success(res, note);
  }

  if (req.method === 'DELETE') {
    const { id } = req.body as { id?: string };
    if (!id) return apiResponse.badRequest(res, 'id is required');

    log.info('Cancelling delivery note', { companyId, id });
    const cancelled = await cancelDeliveryNote(companyId, id);
    if (!cancelled) return apiResponse.badRequest(res, 'Delivery note not found or already cancelled');
    return apiResponse.success(res, { cancelled: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PATCH', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
