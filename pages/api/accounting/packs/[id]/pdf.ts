/**
 * GET /api/accounting/packs/[id]/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Streams the pack as a PDF. The pack is not re-assembled here: the renderer
 * loads the same React page the user saw (?print=1) and photographs it, so a
 * figure can never differ between the screen and the document. The print
 * token that authorises the renderer's own headless-browser requests is
 * minted inside renderPagePdf and never leaves this process.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { renderPagePdf } from '@/lib/pdf/renderPagePdf';
import { sql, type DbRow } from '@/lib/neon';
import { packPrintApiPaths } from '@/modules/accounting/services/packs/packSections';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

const VALID_TYPES: PackType[] = ['board', 'management', 'monthly'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PACK_PAGE = '/accounting/reports/report-packs';

// Same floor as printAuth's own MIN_SECRET_LEN (src/lib/pdf/printAuth.ts):
// mintPrintToken treats a too-short secret as unset and throws. Checked
// here first so that case surfaces as a clear 503, not a 500 from a throw
// deep inside renderPagePdf.
const MIN_SECRET_LEN = 32;

function hasUsablePrintSecret(): boolean {
  const secret = process.env.PRINT_TOKEN_SECRET;
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LEN;
}

/** Lowercase, ASCII-only, dash-separated. Never throws on empty input. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function getCompanySlug(companyId: string): Promise<string> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId}::uuid LIMIT 1`) as DbRow[];
  const name = rows[0]?.name ? String(rows[0].name) : '';
  return slugify(name) || 'company';
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!VALID_TYPES.includes(id as PackType)) {
    return apiResponse.badRequest(res, `id must be one of: ${VALID_TYPES.join(', ')}`);
  }

  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  // Validated before they reach a URL the renderer navigates to.
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return apiResponse.badRequest(res, 'from and to must be YYYY-MM-DD dates');
  }

  if (!(await checkReportRateLimit(companyId, 'packs-pdf'))) {
    log.warn('Pack PDF rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report exports. Please try again shortly.');
  }

  if (!hasUsablePrintSecret()) {
    log.warn('Pack PDF requested with no usable PRINT_TOKEN_SECRET', { companyId }, 'pdf');
    return apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, 'PDF export is not available right now.');
  }

  const [pdf, companySlug] = await Promise.all([
    renderPagePdf({
      companyId,
      userId: user.id,
      path: PACK_PAGE,
      query: { pack: id, from, to },
      apiPaths: packPrintApiPaths(id as PackType),
    }),
    getCompanySlug(companyId),
  ]);

  log.info('Pack PDF downloaded', { companyId, userId: user.id, packType: id, from, to, bytes: pdf.length }, 'packs');

  const filename = `${companySlug}-report-pack-${id}-${from}-to-${to}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdf.length);
  return res.status(200).end(pdf);
}

export default withAuth(withErrorHandler(handler as never));
