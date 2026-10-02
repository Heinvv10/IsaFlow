/**
 * Page 4 — the board's commentary, the derived action panel, and the notes
 * about the figure set that belong on the first page a board reads. Lifted
 * out of `buildBoardPackPages` whole for the 300-line cap: the statement
 * below is the composer's own, unchanged, and it calls this where it stood.
 */
import { boardActionMatters, narrativeTitle } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import type { MoneyScale } from '@/lib/format/money';
import { buildCommentaryBlocks } from './packPageBlocks';
import type { SelectedMatters } from './packMattersPrinted';
import { page, type UnnumberedPage } from './packFrontMatter';
import type { ledgerStalenessNote } from './packLedgerStaleness';
import type { shortenedPanelsNote } from './packShortenedPanels';
import type { receivablesBaseNote } from './packReceivablesReconciliation';
import type { BoardPackInput } from './packBoardPackInput';
import type { PackNarrative } from './packPageModel';

export const pending: PackNarrative = { status: 'pending', body: null, actions: [] };

export function buildNarrativePage(
  matters: SelectedMatters,
  scale: MoneyScale,
  input: BoardPackInput,
  staleLedger: ReturnType<typeof ledgerStalenessNote>,
  debtorsBase: ReturnType<typeof receivablesBaseNote>,
  shortPanels: ReturnType<typeof shortenedPanelsNote>,
): UnnumberedPage {
  // Page 4 — no tabular figures. Spec §4.A keeps this page free of them; both
  // of its columns are prose.
  //
  // TWO COLUMNS, AND THE SECOND ONE IS WHY THE PAGE IS NOT NEARLY EMPTY.
  // Nothing in this codebase stores board commentary yet, so the left column
  // is the visible "Commentary pending approval." placeholder on every pack
  // today — and the page was built as commentary-ONLY, so that single italic
  // line was the whole sheet at 1.0% fill. §4.A specifies an action panel
  // beside it and it was simply never populated. Filled from the same matters
  // model page 11 tabulates, the page carries content whether or not
  // commentary is approved, so the pack is TWELVE pages either way (R-P57)
  // rather than changing shape according to an editorial state — a director
  // comparing two months' packs must not see the structure move.
  //
  // The placeholder STAYS. Filling the panel is not a way to stop saying that
  // commentary is owed and unwritten.
  //
  // THE TITLE IS ABOUT THIS PAGE'S PAYLOAD — see `narrativeTitle`, and note
  // that `boardActionMatters` is the same list the panel below prints, not a
  // second count of the selection.
  //
  // Its footnote went with the old title: `narrativeComparativeFootnote`
  // existed to explain why the headline's net-profit percentage could not be
  // formed, and the headline no longer states one. It was also the second
  // unanchored footnote in the pack.
  const narrativePage = page(
    narrativeTitle(boardActionMatters(matters), [...matters.printed, ...matters.omitted], scale),
    'Commentary and actions',
    'Performance',
    'medium',
    // AND THE ONE FACT ABOUT THE FIGURE SET THAT BELONGS ON THE FIRST PAGE
    // A BOARD READS: whether the ledger has moved since it was last posted
    // to. Null on a current ledger, which is most packs — see
    // `ledgerStalenessNote` for the three conditions and for why this sheet
    // rather than page 5 or page 12.
    [
      ...buildCommentaryBlocks(input.commentary ?? pending, matters),
      ...(staleLedger === null ? [] : [staleLedger]),
      ...(debtorsBase === null ? [] : [debtorsBase]),
      ...(shortPanels === null ? [] : [shortPanels]),
    ],
    'portrait',
    [],
  );
  return narrativePage;
}
