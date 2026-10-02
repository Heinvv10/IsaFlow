/**
 * What the caller hands `buildBoardPackPages` — every input that needs the
 * database, fetched before the synchronous composer runs. Split out of
 * `boardPackPages.ts` for the 300-line cap; that file re-exports
 * `BoardPackInput`, so every caller still imports it there.
 */
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackBrand } from '@/modules/accounting/services/packs/packBrand';
import type { PackMatter } from './packMatters';
import type { PackReceivablesRead } from './packReceivablesReconciliation';
import type { PackDraftReason } from './packDraftStatus';
import type { PackNarrative } from './packPageModel';

export interface BoardPackInput {
  /** Page 1's headline — the company's legal name, exempt from the message rule. */
  companyLegalName: string;
  /** Human-readable period, e.g. '1 March 2026 to 31 August 2026'. */
  period: string;
  generatedAt: string;
  /**
   * Every reason this pack is not final, from `draftReasons(...)`. Empty
   * means final.
   *
   * NOT a boolean. "The fiscal period is closed" and "a human approved the
   * commentary" are two facts, and one flag carrying both is how the
   * Brightsphere pack — no approved commentary, inverted colours, three panel
   * titles reading "rose from – to –" — told a board it was FINAL while the
   * demo pack, from the same command on the same day, said DRAFT.
   */
  draftReasons: PackDraftReason[];
  preparedBy: string;
  brand: PackBrand;
  set: PackFigureSet;
  trend: PackTrendPoint[];
  matters: PackMatter[];
  /**
   * What the pack knows about its own receivables: the aged debtors total
   * where a sheet prints it, the full open subledger, and
   * `reconcileSubledger`'s decomposition of the difference between the
   * subledger and the control account. Page 11 reconciles the two printed
   * debtors figures from it and page 4 discloses which of them debtor days
   * is measured on. See `packReceivablesReconciliation.ts`.
   */
  receivables: PackReceivablesRead;
  /** Page 4's board commentary. Null renders the pending placeholder (R7),
   *  and is also one of the two things that keep a pack a DRAFT — see
   *  `draftReasons`. */
  commentary: PackNarrative | null;
  /** Page 11's commentary on the matters. Null renders the placeholder. */
  mattersCommentary: PackNarrative | null;
  /** `getLedgerPostedThrough(...)`. Null renders explicit unavailable text (R-P46). */
  ledgerVersion: string | null;
}
