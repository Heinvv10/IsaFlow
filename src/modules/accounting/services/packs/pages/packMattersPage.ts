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
import { mattersExposure, omittedQuantum, type SelectedMatters } from './packMattersPrinted';
import { matterSourcesInWords } from './packDerivedMatters';
import { remainingPageMm } from './packPageFit';
import { MATTERS_OMITTED_NOTE_MM } from './packPageMetrics';
import type { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackMatter } from './packMatters';
import { formatMoney, inScale, type MoneyScale } from '@/lib/format/money';
import type { PackNarrative, PackPageBlock } from './packPageModel';

/** The page's short name in the Contents, and the 16pt heading it prints
 *  above its title. */
export const MATTERS_NAV_LABEL = 'Matters for the board';

/**
 * The clause the headline states its exposure in, when it states one at all —
 * a page whose matters carry no rand amount says so in words instead.
 *
 * Exported so `checkMattersAmounts` looks for the same string the page prints
 * rather than a second spelling of it, and so it stays silent on the page that
 * states no amount rather than inventing one to check.
 */
export const EXPOSURE_CLAUSE = ' of exposure';

/**
 * PAGE 11'S TITLE, WHICH USED TO BE ITS OWN CATEGORY LABEL TWICE.
 *
 * The sheet read "Matters for the board" over "Matters requiring board
 * attention" — the page's name restated as the page's name — on a page whose
 * own body carries the conclusion: twenty-eight matters, five printed, R658k
 * of exposure not printed, two statutory filings overdue. Every other content
 * page's title is a sentence about the period; this one asked a director to
 * read the table to find out whether it mattered.
 *
 * Derived from the FULL matters list rather than from the printed selection,
 * because the selection depends on how much paper the title leaves — the
 * headline must not change when a row moves off the page, and the page must
 * still state what is not on it.
 */
export function mattersTitle(matters: PackMatter[], scale: MoneyScale): string {
  const findings = matters.filter((m) => m.kind === 'finding');
  const failed = matters.filter((m) => m.kind === 'checkFailed').length;
  const failedClause = failed === 0
    ? ''
    : ` ${failed === 1 ? 'One check' : `${failed} checks`} could not be run and ${failed === 1 ? 'is' : 'are'} listed as a matter.`;

  if (findings.length === 0) {
    // "0 matters", not "No matter": `assertPageTitleIsAMessage` refuses a
    // title with no figure and no direction word in it, and it is right to —
    // a page that says nothing happened should say so with the count.
    return `0 matters require a board decision this period.${failedClause || ' Every check ran clean.'}`;
  }
  const quantified = findings.filter((m) => m.quantum !== null);
  // THE SAME FUNCTION THE NOTE UNDER THE TABLE USES. The headline totalled
  // absolute quanta and the note totalled signed ones, so the page stated one
  // word — exposure — under two conventions. See `mattersExposure`.
  const total = mattersExposure(findings) ?? 0;
  const noun = findings.length === 1 ? 'matter requires' : 'matters require';
  // WITH ITS UNIT. It read "26 of them carrying 1 675 of exposure" over a note
  // reading "They come to 658 R'000 in total" — two figures about two
  // different sets, one of which said what it was measured in. A reader with
  // no scale on the larger number reads the pair as a contradiction.
  //
  // AND IN THE FORM PROSE STATES A UNIT IN, which is not the banner token
  // pushed up against the figure — see `inScale`. This sentence and page
  // 10's shared-scale note were the only two places in the pack where
  // `R'000` trailed a number instead of heading a column.
  const exposure = quantified.length === 0
    ? 'none of them carrying a single rand amount'
    : `${quantified.length} of them carrying ${inScale(`${formatMoney(total, { scale })}${EXPOSURE_CLAUSE}`, scale)}`;
  return `${findings.length} ${noun} a board decision, ${exposure}.${failedClause}`;
}

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
export function buildMattersSupportBlocks(
  commentary: PackNarrative,
  /** The two-debtors-figures reconciliation, or null where the pack prints
   *  one debtors figure. It is a SUPPORT block deliberately: see
   *  `packReceivablesReconciliation.ts` for why it is budgeted against the
   *  table rather than appended after it. */
  receivables: PackPageBlock | null = null,
): PackPageBlock[] {
  return [
    { kind: 'narrative', narrative: commentary },
    ...(receivables === null ? [] : [receivables]),
    // TWO NOTES MERGED INTO ONE, AND THE MERGE IS THE POINT. This block is
    // not prose the fitter can drop — it is subtracted from the table's
    // budget BEFORE the selection runs (`mattersBudgetMm`), so every
    // millimetre it takes is a matter that does not print. At four lines it
    // was costing the live demo pack a row: JE-2026-00085 at 339 moved out of
    // the table and into the "further matters are not printed" tail, which is
    // real exposure leaving the page a director reads.
    //
    // Both facts stay. "A source that fails is named as a matter, never
    // dropped" is the silent-omission guarantee `packMatters.ts` states, and
    // "no prior pack is stored, so movement is untracked" is why the Movement
    // column reads untracked. What went is the clause explaining what
    // movement is NOT computed from — a period comparison "which would answer
    // a different question" — which describes an arithmetic the pack does not
    // perform. Two lines instead of four, and the row comes back.
    disclose('What was checked', [
      // THE FIFTH CHECK, AND IT IS PAID FOR RATHER THAN ADDED. This note
      // answered "what was checked?" with four sources and the table three
      // lines above it carried the net-credit month — 1 869 on the demo,
      // 4 128 on Brightsphere, the largest exposure in each and produced by
      // none of the four. The list is rendered from `MATTER_SOURCES` now, so
      // the enumeration cannot fall behind the checks again.
      //
      // What went to pay for it is "No prior pack is stored, so movement is
      // untracked", which is the Movement line's own sentence — that line
      // prints DIRECTLY BELOW this block on the same sheet, reading "Not
      // tracked — no prior board pack is stored to compare against. The same
      // for every matter listed above." One fact, twice, on one page, on the
      // page whose paper is measured in matters rows. The silent-omission
      // guarantee stays, because nothing else on the sheet states it.
      note('Sources', `${matterSourcesInWords().charAt(0).toUpperCase()}${matterSourcesInWords().slice(1)}. A source that fails is named as a matter, never dropped.`),
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
export function mattersBudgetMm(support: PackPageBlock[], title: string): number {
  return remainingPageMm(page(title, MATTERS_NAV_LABEL, 'Governance', 'medium', [
    { kind: 'matters', matters: [], omitted: null },
    ...support,
  ])) - MATTERS_OMITTED_NOTE_MM;
}
