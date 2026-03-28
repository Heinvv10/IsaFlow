/**
 * Customer Quotes API
 * GET  — list quotes (search, status, limit, offset)
 * POST — create quote
 * PUT  — update quote (requires id in body)
 * DELETE — delete quote (requires id in body)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { getQuotes, getQuote, createQuote, updateQuote, deleteQuote } from '@/modules/accounting/services/quoteService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const { id, status, search, limit, offset } = req.query;
    if (id) {
      const quote = await getQuote(companyId, id as string);
      if (!quote) return apiResponse.notFound(res, 'Quote', id as string);
      return apiResponse.success(res, quote);
    }
    const result = await getQuotes(companyId, {
      status: status as string,
      search: search as string,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const userId = req.user.id;
    const quote = await createQuote(companyId, req.body, userId);
    return apiResponse.created(res, quote);
  }

  if (req.method === 'PUT') {
    const { id, ...input } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    const quote = await updateQuote(companyId, id, input);
    if (!quote) return apiResponse.badRequest(res, 'Quote not found or not in draft status');
    return apiResponse.success(res, quote);
  }

  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    const deleted = await deleteQuote(companyId, id);
    if (!deleted) return apiResponse.badRequest(res, 'Quote not found or not in draft status');
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
