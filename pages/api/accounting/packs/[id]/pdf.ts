/**
 * GET /api/accounting/packs/[id]/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Streams the pack as a PDF. The pack is not re-assembled here: the renderer
 * loads the same React page the user saw (?print=1) and photographs it, so a
 * figure can never differ between the screen and the document. The print
 * token that authorises the renderer's own headless-browser requests is
 * minted inside renderPagePdf and never leaves this process.
 *
 * WHEN THE RENDER FAILS, THE REASON HAS TO REACH A HUMAN. The figure
 * integrity gate (spec §7.2) refuses a pack whose balance sheet does not
 * foot, and it is right to: Brightsphere's is out by R450 and that sentence
 * is the entire value of the gate. But the refusal happens INSIDE the
 * headless browser — the print page renders the message on screen and
 * deliberately never sets `data-print-ready` — so all the transport could see
 * was its own 30-second `waitForSelector` timeout, and the user received a
 * corrupt download named `.pdf` or a message naming no cause at all. So a
 * failed render is DIAGNOSED here, by composing the same document in this
 * process and reporting what it refuses on. Only on the failure path: the
 * happy path composes nothing extra.
 *
 * THE FOOTER AND THE PDF METADATA ARE BUILT HERE TOO. `buildFooterHtml` and
 * `buildPdfMetadata` existed with no caller at all, so every pack printed
 * Chromium's bare `n / m` and `pdfinfo` reported no metadata — a document a
 * director forwards to their bank with no company, no period and no
 * confidentiality mark on any page. Neither can be CSS: Blink implements
 * neither `@bottom-center` margin boxes nor `position: running()`, and both
 * would draw nothing silently.
 *
 * `landscape` is deliberately NOT passed. It turns the WHOLE document
 * sideways; page 10 alone is landscape, through the named `@page` rule in
 * `styles/print.css` that keys off the page's own `data-print-landscape`.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { renderPagePdf } from '@/lib/pdf/renderPagePdf';
import { withRenderSlot } from '@/lib/pdf/withRenderSlot';
import { sql, type DbRow } from '@/lib/neon';
import { buildFooterHtml, buildPdfMetadata, PACK_CONFIDENTIALITY } from '@/lib/pdf/printFurniture';
import { buildBoardPackDocument } from '@/modules/accounting/services/packs/pages/boardPackDocument';
import { formatPackPeriod } from '@/modules/accounting/services/packs/pages/packPeriodLabel';
import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import { packDownloadFilename } from '@/modules/accounting/services/packs/packDownloadName';
import { PACK_LABELS, packPrintApiPaths } from '@/modules/accounting/services/packs/packSections';
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

/** The one pack type composed as a page model, and so the only one whose
 *  refusal this route can reproduce. See `packs/[id]/pages.ts`. */
const PAGES_PACK_TYPE = 'board';

/**
 * Why the render refused, in the words the gate used — or null when composing
 * the document succeeds and the failure was the renderer's own.
 *
 * Composing is READ-ONLY, like `pages.ts`, which matters: `withAuth` COMMITs
 * before the response flushes and only rolls back on a 5xx, so a 422 returned
 * after a write would COMMIT that write. Nothing here writes.
 */
async function packRefusalReason(
  packType: string,
  request: { companyId: string; from: string; to: string; preparedBy: string },
): Promise<string | null> {
  if (packType !== PAGES_PACK_TYPE) return null;
  try {
    await buildBoardPackDocument({ ...request, generatedAt: new Date().toISOString() });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function getCompanyName(companyId: string): Promise<string> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId}::uuid LIMIT 1`) as DbRow[];
  return rows[0]?.name ? String(rows[0].name) : '';
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

  // The render slot is already held: `withRenderSlot` wraps withAuth from the
  // OUTSIDE (see the export below), so a request that had to queue for one was
  // not holding a pool connection or an open transaction while it waited. By
  // the time this handler runs, the process has decided it has capacity.
  const preparedBy = user.email ?? 'IsaFlow';
  const companyName = await getCompanyName(companyId);

  // The same rule the pack itself applies (`boardPackDocument.ts`): FINAL only
  // when the period the window ends in is closed. A footer that said FINAL
  // over figures that can still move is the more dangerous of the two errors,
  // and the body watermark and the footer must not disagree.
  const furniture = {
    companyName,
    packLabel: PACK_LABELS[id as PackType],
    period: formatPackPeriod(from, to),
    confidentiality: PACK_CONFIDENTIALITY,
    draft: (await getPeriodStatusForDate(companyId, to)) !== 'closed',
  };

  let pdf: Buffer;
  try {
    pdf = await renderPagePdf({
      companyId,
      userId: user.id,
      path: PACK_PAGE,
      query: { pack: id, from, to },
      apiPaths: packPrintApiPaths(id as PackType),
      footerHtml: buildFooterHtml(furniture),
      metadata: buildPdfMetadata(furniture),
    });
  } catch (error) {
    const refusal = await packRefusalReason(id, { companyId, from, to, preparedBy });
    if (refusal === null) throw error;
    log.warn(
      'Pack PDF refused by the figure integrity gate',
      { companyId, userId: user.id, packType: id, from, to, refusal },
      'packs',
    );
    // 422, not 500: the pack is unrenderable because its own figures do not
    // reconcile, which is a fact about this company's ledger rather than a
    // fault in the renderer. The message is the gate's own, verbatim — a
    // paraphrase would lose the amount and the account that name the break.
    return apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION, refusal);
  }

  log.info('Pack PDF downloaded', { companyId, userId: user.id, packType: id, from, to, bytes: pdf.length }, 'packs');

  const filename = packDownloadFilename(companyName, id, from, to, 'pdf');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdf.length);
  return res.status(200).end(pdf);
}

/**
 * `withRenderSlot` is OUTSIDE `withAuth` on purpose. withAuth takes a pool
 * connection and opens a transaction before the handler runs, so acquiring the
 * slot inside meant a queued render waited while holding both — the queue
 * consumed the pool the bound exists to protect. See src/lib/pdf/withRenderSlot.ts.
 */
export default withRenderSlot(withAuth(withErrorHandler(handler as never)));
