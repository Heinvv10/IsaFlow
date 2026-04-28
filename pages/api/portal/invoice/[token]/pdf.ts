/**
 * GET /api/portal/invoice/[token]/pdf
 *
 * Public, token-gated sealed-PDF download for customers. Serves the
 * PRD-06 Phase 1 snapshot bytes when present; falls back to an on-demand
 * render for legacy invoices that pre-date the snapshot. Logs a
 * `pdf_link` view row per download so the AR list "last viewed" column
 * picks up downloads separately from portal-page hits.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { downloadCapturedDocument } from '@/lib/supabaseStorage';
import { generateInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfBuilder';
import { getInvoicePdfFilename } from '@/modules/accounting/services/ar/invoicePdfService';
import { getSealedInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfSnapshotService';
import {
  hashSessionToken,
  verifyInvoicePortalToken,
} from '@/modules/accounting/services/ar/portalTokenService';
import { logCustomerInvoiceView } from '@/modules/accounting/services/ar/readReceiptService';

function clientIp(req: NextApiRequest): string | null {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0]!.trim();
  if (Array.isArray(xf) && xf[0]) return xf[0]!.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? null;
}

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
    return;
  }

  const token = req.query.token as string | undefined;
  const verified = await verifyInvoicePortalToken(token ?? '');
  if (!verified) {
    apiResponse.notFound(res, 'Invoice');
    return;
  }

  const started = Date.now();
  const { invoiceId, companyId } = verified;

  try {
    const sealed = await getSealedInvoicePdf(companyId, invoiceId);
    let buffer: Buffer;
    let source: 'sealed' | 'rendered';

    if (sealed) {
      buffer = await downloadCapturedDocument(sealed.bucket, sealed.path);
      source = 'sealed';
    } else {
      buffer = await generateInvoicePdf(companyId, invoiceId);
      source = 'rendered';
    }

    const filename = await getInvoicePdfFilename(companyId, invoiceId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('X-Evidence-Source', source);
    if (sealed) res.setHeader('X-Evidence-Sha256', sealed.sha256);
    res.status(200).end(buffer);

    await logCustomerInvoiceView({
      invoiceId,
      companyId,
      viewSource: 'pdf_link',
      sessionTokenHash: hashSessionToken(token!),
      ipAddress: clientIp(req),
      userAgent:
        typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      responseTimeMs: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to serve invoice PDF';
    log.error('Portal sealed PDF failed', { invoiceId, error: message }, 'portal-invoice-pdf');
    apiResponse.internalError(res, err, message);
  }
}

export default withErrorHandler(handler);
