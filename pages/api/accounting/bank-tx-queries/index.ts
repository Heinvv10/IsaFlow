/**
 * Bank-Tx Client Queries API (Dotbiz Workstream D)
 *
 * GET  /api/accounting/bank-tx-queries?status=&bankTransactionId=
 *   → List queries for the company, newest first (joined with tx context).
 *
 * POST /api/accounting/bank-tx-queries
 *   Body: { bankTransactionId, toNumber, message?, saveAsDefault? }
 *   → Compose (or use supplied message), send via WhatsApp, record the query.
 *     The row is recorded BEFORE the send and taken back out when the send is refused (no send → no row, with the
 *     reason). Rate-limited per company and per IP.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { checkSendRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import {
  createAndSendQuery,
  listQueries,
} from '@/modules/accounting/services/capture/bankTxQueryService';

const StatusSchema = z.enum(['sent', 'replied', 'resolved', 'cancelled']);

const PostSchema = z.object({
  bankTransactionId: UUID,
  toNumber: z.string().min(8).max(30),
  message: z.string().max(1000).optional(),
  saveAsDefault: z.boolean().optional(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    const status = statusRaw ? StatusSchema.safeParse(statusRaw) : null;
    if (status && !status.success) return apiResponse.badRequest(res, 'invalid status');
    const txIdRaw = typeof req.query.bankTransactionId === 'string' ? req.query.bankTransactionId : undefined;
    const txId = txIdRaw ? UUID.safeParse(txIdRaw) : null;
    if (txId && !txId.success) return apiResponse.badRequest(res, 'invalid bankTransactionId');

    const rows = await listQueries(companyId, {
      status: status?.success ? status.data : undefined,
      bankTransactionId: txId?.success ? txId.data : undefined,
    });
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const parsed = PostSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    // The default number is the company's setting, which only an owner or admin changes (settings PATCH).
    if (parsed.data.saveAsDefault && req.companyRole !== 'owner' && req.companyRole !== 'admin') {
      return apiResponse.forbidden(res, 'Only an owner or admin can change the company\'s default query number');
    }
    // A per-company ceiling on messages sent to clients' phones (15 minutes and a day): a loop of POSTs is a WhatsApp bill.
    if (!(await checkSendRateLimit(req, companyId, 'bank-tx-queries', { ipMax: 30, companyMax: 30, dailyMax: 200 }))) {
      log.warn('Bank tx queries rate limit exceeded', { companyId }, 'rateLimit');
      return apiResponse.tooManyRequests(res, 'Too many client queries sent. Please try again shortly.');
    }
    const result = await createAndSendQuery(companyId, {
      bankTransactionId: parsed.data.bankTransactionId,
      toNumber: parsed.data.toNumber,
      message: parsed.data.message ?? null,
      saveAsDefault: parsed.data.saveAsDefault ?? false,
      userId: req.user?.id ?? null,
    });
    if (!result.ok) return apiResponse.badRequest(res, result.reason);
    return apiResponse.created(res, result.query, 'Query sent');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
