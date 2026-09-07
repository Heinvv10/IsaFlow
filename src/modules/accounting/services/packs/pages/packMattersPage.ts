/**
 * PAGE 11, AND THE BUDGET IT SPENDS ON ITSELF.
 *
 * Split from `packPageBlocks.ts` at the 300-line cap, along the seam the page
 * already has: page 11 is the one page in the pack whose CONTENT depends on
 * how much paper it has left, so the block builder and the arithmetic that
 * decides how many rows it carries belong together. `boardPackPages.ts` reads
 * both and stays a sequence.
 */
import { page } from './packFrontMatter';
import { disclose, note } from './packPageBlocks';
import { omittedQuantum, type SelectedMatters } from './packMattersPrinted';
import { remainingPageMm } from './packPageFit';
import { MATTERS_OMITTED_NOTE_MM } from './packPageMetrics';
import type { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackMatter } from './packMatters';
import type { PackNarrative, PackPageBlock } from './packPageModel';

/** The page's own title and its short name in the Contents — read by the
 *  page itself and by the probe that measures what it has left. */
export const MATTERS_TITLE = 'Matters requiring board attention';
export const MATTERS_NAV_LABEL = 'Matters for the board';

/**
 * Page 11 — the matters, with each quantum recorded through the provenance
 * map (I-4).
 *
 * The source is indexed by RANK, which is the only stable identifier a matter
 * has: `buildMatters` orders them by quantum, largest first, and two matters
 * from different sources can carry the same issue text. It must be unique per
 * matter — one source issued twice with two values is what `assertConsistent`
 * throws on, and it would take the render with it.
 */
const NO_QUANTUM =
  'This matter has no single rand amount — an overdue filing, or a check that found nothing to quantify.';

const OMITTED_NOT_QUANTIFIED =
  'None of the matters not printed here carries a single rand amount, so they have no total to state.';

export function buildMattersBlock(selection: SelectedMatters, p: PackFigureProvenance): PackPageBlock {
  // What FITS on the sheet, and what is left over — see `packMattersPrinted`.
  // The selection is made ONCE, by `buildBoardPackPages`, and page 4's action
  // panel is handed the same object: the two pages cannot disagree about the
  // board's action list because there is only one list.
  //
  // The index a quantum is recorded under is the matter's rank in the FULL
  // list as `buildMatters` returned it — `selection.source`, not the printing
  // order — so a source is still unique per matter and still traces back to
  // the same finding whether or not the page had room to print it, and it
  // does not move when the printing order does.
  const { printed, omitted, source } = selection;
  const rank = new Map<PackMatter, number>(source.map((matter, index) => [matter, index]));
  const total = omittedQuantum(omitted);

  return {
    kind: 'matters',
    matters: printed.map((matter) => {
      const { quantum, ...rest } = matter;
      const source = `buildMatters.quantum.${rank.get(matter) ?? 0}`;
      return {
        ...rest,
        quantum: quantum === null
          ? p.figure(source, null, 'money', NO_QUANTUM)
          : p.figure(source, quantum, 'money'),
      };
    }),
    omitted: omitted.length === 0 ? null : {
      count: omitted.length,
      quantum: total === null
        ? p.figure('buildMatters.omittedQuantum', null, 'money', OMITTED_NOT_QUANTIFIED)
        : p.figure('buildMatters.omittedQuantum', total, 'money'),
    },
  };
}


/**
 * Everything page 11 carries BESIDE its table: the approver's commentary on
 * the matters, and the note saying what was checked to produce them.
 *
 * Built before the table, because the table's budget is what these leave
 * behind.
 */
export function buildMattersSupportBlocks(commentary: PackNarrative): PackPageBlock[] {
  return [
    { kind: 'narrative', narrative: commentary },
    disclose('What was checked', [
      note('Sources', 'Aged debtor concentration, unreconciled bank items, unusual journals and overdue statutory filings. A source that fails appears as a named matter, never as a silent omission.'),
      note('Movement', 'No prior board pack is stored, so movement since the last meeting is stated as untracked rather than computed from a period comparison, which would answer a different question.'),
    ]),
  ];
}

/**
 * The millimetres page 11 has for its table.
 *
 * It was a constant in `packMattersPrinted.ts`, swept against the print
 * harness until a fixture spilled — right for the fixtures that existed and
 * silent about the page. Change this page's commentary or its disclosure and
 * the constant is wrong with nothing to say so, which is how the pack has now
 * produced three thirteen-sheet renders from three different blocks.
 *
 * The "N further matters are not printed" note is RESERVED rather than
 * discovered: the probe below carries an empty table, and the moment the
 * selection leaves a matter out the block grows that note.
 */
export function mattersBudgetMm(support: PackPageBlock[]): number {
  return remainingPageMm(page(MATTERS_TITLE, MATTERS_NAV_LABEL, 'Governance', 'medium', [
    { kind: 'matters', matters: [], omitted: null },
    ...support,
  ])) - MATTERS_OMITTED_NOTE_MM;
}
