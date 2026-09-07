/**
 * Everything the board pack needs from the database, fetched once, then
 * composed.
 *
 * `buildBoardPackPages` is synchronous by contract — it chooses which model
 * lands on which page and computes nothing — so SOMETHING has to do the
 * fetching. This is that something, and it is the only place the twelve-page
 * pack meets the ledger.
 *
 * SEQUENTIAL, NOT `Promise.all`. Under `withAuth` a request-scoped
 * transaction is in flight and `sql` routes every query through the ONE pg
 * client held in the async-local store; concurrent queries on a single pg
 * connection are a known hazard in this repo. `buildPackFigureSet` documents
 * the same rule for the same reason.
 *
 * READ-ONLY. `withAuth` COMMITs its transaction before the response flushes
 * and only rolls back on a 5xx, so a 4xx after a write would COMMIT that
 * write. Nothing here writes, and nothing here should start.
 */

import { log } from '@/lib/logger';
import { getCompanyName } from '@/modules/accounting/services/reports/companyName';
import { getBrandProfile } from '@/modules/accounting/services/afs/brandProfileService';
import { readPackDraftState } from './packDraftState';
import {
  getLedgerPostedThrough,
  NO_LEDGER_READ,
} from '@/modules/accounting/services/reports/postedThroughService';
import { resolvePackBrandForRender } from '@/modules/accounting/services/packs/packBrandForRender';
import { buildPackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { getPackTrend } from '@/modules/accounting/services/packs/packTrendService';
import { buildMatters } from './packMatters';
import { formatPackPeriod } from './packPeriodLabel';
import { buildBoardPackPages } from './boardPackPages';
import type { PackPagesDocument } from './packPageModel';

/** Re-exported: both formatters moved to `packPeriodLabel.ts` so
 *  `boardPackPages.ts` can head its comparative column with the same words
 *  page 1 heads the current period with, without importing this module and
 *  closing a cycle. Every existing import path still resolves. */
export { formatPackDate, formatPackPeriod } from './packPeriodLabel';

const TREND_MONTHS = 12;

export interface BoardPackDocumentRequest {
  companyId: string;
  from: string;
  to: string;
  /** Printed on page 1 as the preparer. The authenticated caller. */
  preparedBy: string;
  /** ISO timestamp the ledger was read at — page 12's `extractedAt`. */
  generatedAt: string;
}

export async function buildBoardPackDocument(
  request: BoardPackDocumentRequest,
): Promise<PackPagesDocument> {
  const { companyId, from, to } = request;

  const companyLegalName = await getCompanyName(companyId);
  const set = await buildPackFigureSet(companyId, companyLegalName, from, to);
  const trend = await getPackTrend(companyId, to, TREND_MONTHS);
  const matters = await buildMatters(companyId, set.currentWindow);
  const brand = await resolvePackBrandForRender(await getBrandProfile(companyId));

  // R-P46: the real ledger watermark, or an explicit absence — never a proxy.
  // `getLedgerPostedThrough` still returns the deprecated epoch sentinel when
  // the window consumed no posted journal (see its own docblock and
  // docs/mcp/CONTRACTS.md); that is converted to `null` HERE rather than
  // passed on, because page 12 renders null as "unavailable" and would
  // otherwise print 1970-01-01 as this pack's audit anchor.
  const postedThrough = await getLedgerPostedThrough(companyId, to, from);
  const ledgerVersion = postedThrough === NO_LEDGER_READ ? null : postedThrough;

  // A PACK HAS TO EARN "FINAL". It was `periodStatus !== 'closed'`, which
  // measures whether the FIGURES can still move and then asserted something
  // else on the cover — that the pack is finished. Brightsphere's September
  // period is closed in the ledger, so its pack told a board it was FINAL
  // while carrying no approved commentary at all, on the same day the demo
  // pack said DRAFT. Both facts are now stated, and the absence of either
  // produces a draft. Read from `packDraftState.ts` rather than derived here,
  // because the PDF footer and the Info dictionary read the same answer and
  // a second derivation is how they came to disagree with this one. The
  // approved commentary page 4 prints comes back with it: it is the same
  // rows the `unapprovedCommentary` reason is decided on.
  const { reasons, commentary } = await readPackDraftState(companyId, 'board', from, to);

  log.info(
    'buildBoardPackDocument',
    { companyId, from, to, draftReasons: reasons, matters: matters.length, trend: trend.length },
    'packs',
  );

  return buildBoardPackPages({
    companyLegalName,
    period: formatPackPeriod(from, to),
    generatedAt: request.generatedAt,
    draftReasons: reasons,
    preparedBy: request.preparedBy,
    brand,
    set,
    trend,
    matters,
    commentary,
    // Page 11's commentary on the matters. Nothing in this codebase stores
    // board-matter commentary — `report_commentary` rows are filed under
    // statement section refs (`income_statement`, `balance_sheet`) — so this
    // is null and the page prints the pending placeholder. Reusing page 4's
    // approved sentences here would put commentary about the income statement
    // under a heading that says it is about the matters.
    mattersCommentary: null,
    ledgerVersion,
  });
}
