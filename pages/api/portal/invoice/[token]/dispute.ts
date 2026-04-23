/**
 * Portal dispute endpoint — PRD-06 Phase 3.
 *
 * POST /api/portal/invoice/[token]/dispute
 * Anonymous (token-gated), rate-limited to 10 req/min per IP.
 * Accepts optional customerInvoiceLineId (blank = whole-invoice dispute),
 * reason (required), disputedAmount (required, > 0).
 *
 * Notes:
 *   - IP + UA are captured on the dispute row itself (log-only, never rejected).
 *   - raised_by = 'customer:<sessionHash>' where sessionHash = SHA-256 of
 *     the portal token, matching the per-view session_token hash in
 *     customer_invoice_views. Never stores the raw token.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import {
  hashSessionToken,
  verifyInvoicePortalToken,
} from '@/modules/accounting/services/ar/portalTokenService';
import { raiseDispute } from '@/modules/accounting/services/ar/disputeService';

interface DisputeRequestBody {
  reason?: string;
  disputedAmount?: number;
  customerInvoiceLineId?: string | null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(`portal-dispute:${ip}`, { max: 10, windowSecs: 60 });
  if (!allowed) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many dispute attempts. Try again shortly.' },
    });
  }

  const token = req.query.token as string;
  const verified = await verifyInvoicePortalToken(token);
  if (!verified) {
    return apiResponse.notFound(res, 'Invoice');
  }

  if (!['sent', 'approved', 'partially_paid', 'overdue'].includes(verified.status)) {
    return apiResponse.badRequest(res, 'Invoice is not eligible for dispute');
  }

  const body = (req.body ?? {}) as DisputeRequestBody;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const disputedAmount = Number(body.disputedAmount);
  const lineId =
    typeof body.customerInvoiceLineId === 'string' && body.customerInvoiceLineId.length > 0
      ? body.customerInvoiceLineId
      : null;

  if (!reason) {
    return apiResponse.badRequest(res, 'reason is required');
  }
  if (reason.length > 2000) {
    return apiResponse.badRequest(res, 'reason is too long (max 2000 chars)');
  }
  if (!Number.isFinite(disputedAmount) || disputedAmount <= 0) {
    return apiResponse.badRequest(res, 'disputedAmount must be a positive number');
  }

  const userAgent =
    typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;

  try {
    const dispute = await raiseDispute(verified.companyId, {
      customerInvoiceId: verified.invoiceId,
      customerInvoiceLineId: lineId,
      reason,
      disputedAmount,
      raisedBy: `customer:${hashSessionToken(token)}`,
      ipAddress: ip === 'unknown' ? null : ip,
      userAgent,
    });

    log.info(
      'Portal dispute raised',
      { disputeId: dispute.id, invoiceId: verified.invoiceId },
      'Portal',
    );

    return apiResponse.success(res, {
      id: dispute.id,
      status: dispute.status,
      raisedAt: dispute.raisedAt,
      disputedAmount: dispute.disputedAmount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already an open dispute/i.test(message)) {
      return res.status(409).json({
        success: false,
        error: { code: 'DISPUTE_EXISTS', message },
      });
    }
    if (
      /not found or not eligible/i.test(message) ||
      /exceeds outstanding/i.test(message) ||
      /must be greater/i.test(message)
    ) {
      return apiResponse.badRequest(res, message);
    }
    throw err;
  }
}

export default withErrorHandler(handler);
