/**
 * Bank-Tx Client Queries API (Dotbiz Workstream D)
 *
 * GET  /api/accounting/bank-tx-queries?status=&bankTransactionId=
 *   → List queries for the company, newest first (joined with tx context).
 *
 * POST /api/accounting/bank-tx-queries
 *   Body: { bankTransactionId, toNumber, message?, saveAsDefault? }
 *   → Compose (or use supplied message), send via WhatsApp, record the query.
 *     No Twilio send → no row (fails closed with the reason).
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
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
