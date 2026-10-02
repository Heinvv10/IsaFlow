/**
 * ONE READ OF WHETHER A PACK IS A DRAFT, for every surface that says so.
 *
 * `packDraftStatus.ts` defines what draft MEANS; this is the one place that
 * goes to the ledger for the two facts it needs. Both exist because the
 * defect was not the definition — the cover already used it — but a second
 * derivation: `packs/[id]/pdf.ts` computed `draft: periodStatus !== 'closed'`
 * of its own, so Brightsphere, whose period IS closed and whose commentary is
 * NOT approved, printed a DRAFT cover and a watermark on every sheet over
 * footers reading `Confidential — for board use` and PDF metadata saying
 * `Board Pack for …`. A board pack is read as loose sheets: the footer is the
 * line that travels with a forwarded page and the metadata is what a document
 * system indexes, and both said final.
 *
 * So the pack, the running footer and the Info dictionary now read the same
 * answer from here, and a pack that is a draft for ANY reason says so on all
 * three. Adding a third reason to `draftReasons` reaches every surface without
 * touching them.
 *
 * READ-ONLY, and sequential: `withAuth` holds one pg client in the async-local
 * store and concurrent queries on it are a known hazard in this repo.
 */

import { listCommentary } from '@/modules/accounting/services/commentary/commentaryService';
import { getPeriodStatusForDate } from '@/modules/accounting/services/gl/periodStatusService';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';
import { draftReasons, type PackDraftReason } from './packDraftStatus';
import type { PackNarrative } from './packPageModel';

export interface PackDraftState {
  /** Every reason this pack is not final. Empty means it is. */
  reasons: PackDraftReason[];
  /** The approved commentary the pack prints — the same rows the
   *  `unapprovedCommentary` reason is decided on, so the page that shows the
   *  "pending approval" placeholder and the footer that says DRAFT cannot
   *  disagree about whether anybody signed this pack off. */
  commentary: PackNarrative | null;
}

/**
 * The commentary a human actually approved for THIS pack.
 *
 * Commentary is filed against `(type, from, to)` — the pack as a whole. Only
 * `approved` rows are read: a draft is machine-written text nobody signed, and
 * R7 is explicit that a board pack shows a visible "pending approval"
 * placeholder rather than unapproved prose. `null` (no approved row) is what
 * renders that placeholder.
 *
 * `approvedText` rather than `draftText`, and never a fallback between them:
 * the approved column is the text the approver put their name to, which is not
 * necessarily the text that was drafted for them.
 */
async function approvedCommentary(
  companyId: string,
  packType: PackType,
  from: string,
  to: string,
): Promise<PackNarrative | null> {
  const rows = await listCommentary(companyId, { type: packType, from, to });
  const approved = rows
    .filter((row) => row.status === 'approved')
    .map((row) => (row.approvedText ?? '').trim())
    .filter((text) => text !== '');
  if (approved.length === 0) return null;
  return { status: 'approved', body: approved.join(' '), actions: [] };
}

export async function readPackDraftState(
  companyId: string,
  packType: PackType,
  from: string,
  to: string,
): Promise<PackDraftState> {
  const commentary = await approvedCommentary(companyId, packType, from, to);
  const periodStatus = await getPeriodStatusForDate(companyId, to);
  return { reasons: draftReasons(periodStatus, commentary !== null), commentary };
}
