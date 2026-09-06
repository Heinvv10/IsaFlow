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
import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import {
  getLedgerPostedThrough,
  NO_LEDGER_READ,
} from '@/modules/accounting/services/reports/postedThroughService';
import { listCommentary } from '@/modules/accounting/services/commentary/commentaryService';
import { resolvePackBrand } from '@/modules/accounting/services/packs/packBrand';
import { buildPackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { getPackTrend } from '@/modules/accounting/services/packs/packTrendService';
import { buildMatters } from './packMatters';
import { formatPackPeriod } from './packPeriodLabel';
import { buildBoardPackPages } from './boardPackPages';
import type { PackNarrative, PackPagesDocument } from './packPageModel';

/** Re-exported: both formatters moved to `packPeriodLabel.ts` so
 *  `boardPackPages.ts` can head its comparative column with the same words
 *  page 1 heads the current period with, without importing this module and
 *  closing a cycle. Every existing import path still resolves. */
export { formatPackDate, formatPackPeriod } from './packPeriodLabel';

const TREND_MONTHS = 12;

/**
 * Page 4's commentary, from the rows a human actually approved for THIS pack.
 *
 * Commentary is filed against `(type, from, to)` — the pack as a whole — so
 * the approved sentences for the board pack over this period are the board's
 * commentary on this period. Only `approved` rows are read: a draft is
 * machine-written text nobody signed, and R7 is explicit that a board pack
 * shows a visible "pending approval" placeholder rather than unapproved
 * prose. `null` (no approved row) is what renders that placeholder.
 *
 * `approvedText` rather than `draftText`, and never a fallback between them:
 * the approved column is the text the approver put their name to, which is
 * not necessarily the text that was drafted for them.
 */
async function approvedCommentary(
  companyId: string,
  from: string,
  to: string,
): Promise<PackNarrative | null> {
  const rows = await listCommentary(companyId, { type: 'board', from, to });
  const approved = rows
    .filter((row) => row.status === 'approved')
    .map((row) => (row.approvedText ?? '').trim())
    .filter((text) => text !== '');
  if (approved.length === 0) return null;
  return { status: 'approved', body: approved.join(' '), actions: [] };
}

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
  const brand = resolvePackBrand(await getBrandProfile(companyId));
  const commentary = await approvedCommentary(companyId, from, to);

  // R-P46: the real ledger watermark, or an explicit absence — never a proxy.
  // `getLedgerPostedThrough` still returns the deprecated epoch sentinel when
  // the window consumed no posted journal (see its own docblock and
  // docs/mcp/CONTRACTS.md); that is converted to `null` HERE rather than
  // passed on, because page 12 renders null as "unavailable" and would
  // otherwise print 1970-01-01 as this pack's audit anchor.
  const postedThrough = await getLedgerPostedThrough(companyId, to, from);
  const ledgerVersion = postedThrough === NO_LEDGER_READ ? null : postedThrough;

  // A pack is FINAL only when the period the window ends in is closed or
  // locked. An open period — or no fiscal period at all — means these figures
  // can still move, and a board pack that does not say so is the more
  // dangerous of the two errors.
  const draft = (await getPeriodStatusForDate(companyId, to)) !== 'closed';

  log.info(
    'buildBoardPackDocument',
    { companyId, from, to, draft, matters: matters.length, trend: trend.length },
    'packs',
  );

  return buildBoardPackPages({
    companyLegalName,
    period: formatPackPeriod(from, to),
    generatedAt: request.generatedAt,
    draft,
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
