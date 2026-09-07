/**
 * GET /api/accounting/packs/[id]/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Streams the pack as a PDF. The pack is not re-assembled here: the renderer
 * loads the same React PAGE (?print=1) and photographs it, so no figure is
 * computed twice. The print token that authorises the renderer's own
 * headless-browser requests is minted inside renderPagePdf and never leaves
 * this process.
 *
 * IT IS NOT THE SAME DOCUMENT THE USER PREVIEWED, and this comment used to
 * claim it was. `?print=1` dispatches the BOARD pack to `PackPagesPrintPage`
 * — the twelve-page fixed-layout document — while the interactive screen
 * still renders the legacy five-section accordion for every pack type. A
 * reader previews one document and downloads another, and the two do not
 * even fail alike: the interactive board view renders Brightsphere happily
 * while this route refuses it on the integrity gate. Moving the interactive
 * screen onto the page model is its own piece of work; until then, do not
 * reason about this route as if the screen and the PDF agreed.
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
 * THE FOOTER AND THE PDF METADATA COME FROM `buildPackFurniture`, which the
 * proof script `scripts/pdf/render-pack.ts` calls too. They were derived
 * inline here, and the script passed neither — so every clean-room render in
 * `evidence/` printed Chromium's bare `n / m` and reported `Creator:
 * Chromium`, and the sheets a reviewer read carried no company, no period and
 * no confidentiality mark. Neither can be CSS: Blink implements neither
 * `@bottom-center` margin boxes nor `position: running()`, and both would
 * draw nothing silently.
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
import { buildFooterHtml, buildPdfMetadata } from '@/lib/pdf/printFurniture';
import { buildBoardPackDocument } from '@/modules/accounting/services/packs/pages/boardPackDocument';
import { packRefusalMessages } from '@/modules/accounting/services/packs/packRefusal';
import { buildPackFurniture } from '@/modules/accounting/services/packs/pages/packFurniture';
import { packDownloadFilename } from '@/modules/accounting/services/packs/packDownloadName';
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
): Promise<{ user: string; diagnostic: string } | null> {
  if (packType !== PAGES_PACK_TYPE) return null;
  try {
    await buildBoardPackDocument({ ...request, generatedAt: new Date().toISOString() });
    return null;
  } catch (error) {
    return packRefusalMessages(error);
  }
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

  // The running footer and the Info dictionary, built where the proof script
  // builds them too — see `packFurniture.ts` for why that is one function.
  const furniture = await buildPackFurniture(companyId, id as PackType, from, to);

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
      'Pack PDF refused by a compose-time gate',
      { companyId, userId: user.id, packType: id, from, to, refusal: refusal.diagnostic },
      'packs',
    );
    // 422, not 500: the pack is unrenderable because of something about this
    // company's own pack rather than a fault in the renderer.
    //
    // TWO SENTENCES, NOT ONE. An integrity refusal is written for a reader
    // already — "the balance sheet is out by R450 on …" is the whole value of
    // the gate and a paraphrase would lose the amount and the account, so
    // `packRefusalMessages` returns it unchanged. A LAYOUT refusal is not:
    // `fitPageToBox` names itself and quotes millimetres, which is what
    // diagnoses it and not what a person reading a failed download can act on.
    // The full text is logged above either way.
    return apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION, refusal.user);
  }

  log.info('Pack PDF downloaded', { companyId, userId: user.id, packType: id, from, to, bytes: pdf.length }, 'packs');

  const filename = packDownloadFilename(furniture.companyName, id, from, to, 'pdf');
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
