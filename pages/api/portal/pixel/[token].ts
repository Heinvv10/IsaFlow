/**
 * GET /api/portal/pixel/[token] — tracking pixel for emailed invoices.
 *
 * Returns a 1×1 transparent GIF with `Cache-Control: no-store` so mail
 * clients that render the image don't suppress a second view from the
 * cache. The actual view-row insert is fire-and-forget — we never block
 * the response waiting on the DB, because a stalled INSERT would just
 * leave a broken-image icon in the customer's mail client.
 *
 * Token reuses customer_invoices.portal_token (mig 300). Bookkeepers
 * embed the URL in outbound HTML via the statement/email templates.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';
import {
  hashSessionToken,
  verifyInvoicePortalToken,
} from '@/modules/accounting/services/ar/portalTokenService';
import { logCustomerInvoiceView } from '@/modules/accounting/services/ar/readReceiptService';

// 43-byte transparent 1×1 GIF89a
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function clientIp(req: NextApiRequest): string | null {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0]!.trim();
  if (Array.isArray(xf) && xf[0]) return xf[0]!.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? null;
}

function sendPixel(res: NextApiResponse): void {
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', String(PIXEL.length));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.status(200).end(PIXEL);
}

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).end();
    return;
  }

  const rawToken = req.query.token;
  const token = typeof rawToken === 'string'
    ? rawToken.replace(/\.gif$/, '')
    : '';

  // Serve the pixel unconditionally — never let a bad token betray a
  // valid/invalid invoice to a scanner. If the token resolves, we log.
  sendPixel(res);

  const started = Date.now();
  verifyInvoicePortalToken(token)
    .then((verified) => {
      if (!verified) return;
      return logCustomerInvoiceView({
        invoiceId: verified.invoiceId,
        companyId: verified.companyId,
        viewSource: 'tracking_pixel',
        sessionTokenHash: hashSessionToken(token),
        ipAddress: clientIp(req),
        userAgent:
          typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
        responseTimeMs: Date.now() - started,
      });
    })
    .catch((err) => {
      log.warn('Tracking pixel log failed', { err: String(err) }, 'portal-pixel');
    });
}

export default withErrorHandler(handler);
