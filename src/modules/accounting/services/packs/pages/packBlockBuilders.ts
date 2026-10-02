/**
 * The constructors every page builds its prose blocks with. Split from
 * `packPageBlocks.ts`, which imports the page modules that need them.
 */
import type { PackDisclosureNote, PackPageBlock } from './packPageModel';

export const note = (
  heading: string,
  body: string,
  /** The numbered page footnote this note's claim is qualified by, where it
   *  has one — see `PackDisclosureNote.footnote` and `anchorRow`. */
  footnote?: number,
): PackDisclosureNote => (footnote === undefined ? { heading, body } : { heading, body, footnote });

export const disclose = (
  heading: string,
  notes: PackDisclosureNote[],
  /** Two columns for a disclosure whose notes are a LIST rather than an
   *  argument — see `PackDisclosure.columns`. */
  columns?: 2,
): PackPageBlock => ({
  kind: 'disclosure',
  disclosure: columns === undefined ? { heading, notes } : { heading, notes, columns },
});

/**
 * A disclosure the pack is NOT free to leave off the page — §3.5's
 * negative-equity consequence, the negative-assets note beside it, the
 * unexplained-plug sentence the integrity gate demands, and every "why this
 * chart is not here" explanation.
 *
 * The distinction exists for `fitPageToBox`: a page short of paper drops the
 * pack's optional prose first and reaches these last. Without it the trimmer
 * would take whichever note happened to be at the bottom of the page, and on
 * page 7 that is the negative-equity callout.
 */
export const mustDisclose = (heading: string, notes: PackDisclosureNote[]): PackPageBlock => ({
  kind: 'disclosure',
  disclosure: { heading, notes, required: true },
});

/**
 * A deterministic caption, carried as a DERIVED narrative — R-P49.
 *
 * It used to ride in a `disclosure` block: `PackNarrative.status` had no
 * 'derived' member and `NarrativeColumns` printed a body only for
 * 'approved', so the only way to make a machine-written caption render was
 * to claim a human had signed it — a false statement on every page of the
 * pack. The status now exists and the renderer LABELS it as derived, so the
 * workaround is gone and the caption says what it is.
 */
export const commentary = (body: string): PackPageBlock => ({
  kind: 'narrative',
  narrative: { status: 'derived', body, actions: [] },
});
