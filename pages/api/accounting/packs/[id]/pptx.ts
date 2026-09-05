/**
 * GET /api/accounting/packs/[id]/pptx?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Streams the pack as a PowerPoint deck. Unlike the PDF route (which
 * photographs the page), this assembles the pack in-process through the SAME
 * pack service and the SAME PackDocument the page renders, so the two
 * downloads cannot disagree on a figure.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { buildReportPack, type PackType } from '@/modules/accounting/services/reports/reportPackService';
import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildPackDocument } from '@/modules/accounting/services/packs/packDocument';
import { buildPackDeck } from '@/modules/accounting/services/packs/packDeckModel';
import { packDownloadFilename } from '@/modules/accounting/services/packs/packDownloadName';
import { renderPackPptx } from '@/modules/accounting/services/packs/pptxExportService';
import { getPackTrend } from '@/modules/accounting/services/packs/packTrendService';

const VALID_TYPES: PackType[] = ['board', 'management', 'monthly'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const TREND_MONTHS = 12;

async function getCompanyName(companyId: string): Promise<string> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId}::uuid LIMIT 1`) as DbRow[];
  return rows[0]?.name ? String(rows[0].name) : 'Company';
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
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return apiResponse.badRequest(res, 'from and to must be YYYY-MM-DD dates');
  }

  if (!(await checkReportRateLimit(companyId, 'packs-pptx'))) {
    log.warn('Pack PPTX rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report exports. Please try again shortly.');
  }

  const name = await getCompanyName(companyId);
  const [input, trend] = await Promise.all([
    getReportPackInput(companyId, name, from, to),
    getPackTrend(companyId, to, TREND_MONTHS),
  ]);

  const deck = buildPackDeck(buildPackDocument(buildReportPack(id as PackType, input, from, to), trend));
  const pptx = await renderPackPptx(deck);

  log.info('Pack PPTX downloaded', { companyId, userId: user.id, packType: id, from, to, bytes: pptx.length }, 'packs');

  res.setHeader('Content-Type', PPTX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${packDownloadFilename(name, id, from, to, 'pptx')}"`);
  res.setHeader('Content-Length', pptx.length);
  return res.status(200).end(pptx);
}

export default withAuth(withErrorHandler(handler as never));
