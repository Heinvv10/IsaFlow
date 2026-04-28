/**
 * GET  /api/accounting/ar/invoice/[id]/pdf — sealed invoice PDF
 * POST /api/accounting/ar/invoice/[id]/pdf — force snapshot (idempotent)
 *
 * Prefers the sealed Supabase Storage snapshot so the auditor sees the exact
 * bytes the customer received. Falls back to on-demand render when no
 * snapshot exists (legacy invoices pre-PRD-06 Phase 1).
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { downloadCapturedDocument } from '@/lib/supabaseStorage';
import { generateInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfBuilder';
import { getInvoicePdfFilename } from '@/modules/accounting/services/ar/invoicePdfService';
import {
  getSealedInvoicePdf,
  snapshotInvoicePdf,
} from '@/modules/accounting/services/ar/invoicePdfSnapshotService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (!id || typeof id !== 'string') {
    apiResponse.badRequest(res, 'Invoice id is required');
    return;
  }

  if (req.method === 'POST') {
    const snapshot = await snapshotInvoicePdf(companyId, id);
    apiResponse.success(res, {
      documentId: snapshot.documentId,
      sha256: snapshot.sha256,
      renderedAt: snapshot.renderedAt.toISOString(),
      wasExisting: snapshot.wasExisting,
    });
    return;
  }

  if (req.method !== 'GET') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
    return;
  }

  try {
    const sealed = await getSealedInvoicePdf(companyId, id);

    let buffer: Buffer;
    let source: 'sealed' | 'rendered';

    if (sealed) {
      buffer = await downloadCapturedDocument(sealed.bucket, sealed.path);
      source = 'sealed';
    } else {
      buffer = await generateInvoicePdf(companyId, id);
      source = 'rendered';
    }

    const filename = await getInvoicePdfFilename(companyId, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('X-Evidence-Source', source);
    if (sealed) res.setHeader('X-Evidence-Sha256', sealed.sha256);

    res.status(200).end(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to serve invoice PDF';
    log.error('Sealed invoice PDF failed', { invoiceId: id, error: message }, 'ar-invoice-pdf');

    if (/not found/i.test(message)) {
      apiResponse.notFound(res, 'Invoice', id);
      return;
    }
    apiResponse.internalError(res, err, message);
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
