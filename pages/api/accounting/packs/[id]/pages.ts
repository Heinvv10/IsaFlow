/**
 * GET /api/accounting/packs/[id]/pages?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * The composed twelve-page board pack, as JSON.
 *
 * WHY THE DOCUMENT IS BUILT HERE AND NOT IN THE BROWSER. Its charts come from
 * `renderChartSvg`, which imports `node:crypto` and ECharts; `next.config.js`
 * sets `crypto: false` in the client webpack fallback, so that function cannot
 * run in a browser at all. The printed page is a browser page. Server-side
 * composition is the only reachable design, and `packDocumentWire.ts` carries
 * the cost of the boundary it creates: `TrustedChartSvg` does not survive
 * `JSON.parse`, so every SVG is re-branded through `adoptTrustedChartSvg` —
 * which re-runs both guards — on the far side.
 *
 * `board` ONLY. The management and monthly packs still print through the
 * legacy `PackPrintPage`/`reports-pack` path until a later workstream moves
 * them; a route that accepted them would answer with a board pack under
 * another pack's name.
 *
 * READ-ONLY, and it must stay that way: `withAuth` COMMITs its transaction
 * before the response flushes and only rolls back on a 5xx, so a 4xx returned
 * after a write would COMMIT that write.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { buildBoardPackDocument } from '@/modules/accounting/services/packs/pages/boardPackDocument';
import { serialisePackPagesDocument } from '@/modules/accounting/services/packs/pages/packDocumentWire';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The one pack type composed as a page model today. Not `PackType`. */
const PAGES_PACK_TYPE = 'board';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  // From the session, never from the request body or query: this is the only
  // thing standing between one client's board figures and another's.
  const { companyId, user } = req as CompanyAuthedRequest;

  const id = String(req.query.id ?? '');
  if (id !== PAGES_PACK_TYPE) {
    return apiResponse.badRequest(res, `id must be ${PAGES_PACK_TYPE}`);
  }

  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return apiResponse.badRequest(res, 'from and to must be YYYY-MM-DD dates');
  }
  // A backwards window silently produces a pack with no ledger in it, which
  // reads as a dormant company rather than as a mistyped URL.
  if (from > to) return apiResponse.badRequest(res, 'from must not be after to');

  if (!(await checkReportRateLimit(companyId, 'packs-pages'))) {
    log.warn('Board pack pages rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report requests. Please try again shortly.');
  }

  const document = await buildBoardPackDocument({
    companyId,
    from,
    to,
    preparedBy: user.email ?? 'IsaFlow',
    generatedAt: new Date().toISOString(),
  });

  return apiResponse.success(res, serialisePackPagesDocument(document));
}

export default withAuth(withErrorHandler(handler as never));
