/**
 * A page before it knows its number, the constructor every page composer
 * calls, and the one function that numbers the sequence. Split out of
 * `packFrontMatter.ts` for the 300-line cap: the front pages and the basis
 * page both build with `page`, so it is a leaf neither owns.
 */
import type { PackPage } from './packPageModel';

/** A page before it knows its own number — see `numbered` in
 *  `boardPackPages.ts`, which is the only thing that assigns one. */
export type UnnumberedPage = Omit<PackPage, 'number'>;

/**
 * Page numbers, from POSITION in the sequence.
 *
 * They used to be literals at each `page(...)` call — `page(4, …)`,
 * `page(12, …)`. The sequence is fixed at twelve by spec §4.A (R-P57) and
 * those agreed with the spec's own numbering, so nothing about the printed
 * pack changed. What changed is that the contents, the footer and page 2's
 * "full basis on page N" now READ the sequence instead of restating it: the
 * rendered pack printed "Full basis on page 12" while the basis was on sheet
 * 19, and a literal cannot notice.
 */
export function numbered(pages: UnnumberedPage[]): PackPage[] {
  return pages.map((page, index) => ({ ...page, number: index + 1 }));
}

/**
 * @param navLabel The short name for the contents. `title` is a CONCLUSION by
 *   rule, so an index built from it lists sentences rather than page names.
 */
export function page(
  title: string,
  navLabel: string,
  section: PackPage['section'],
  density: PackPage['density'],
  blocks: PackPage['blocks'],
  orientation: PackPage['orientation'] = 'portrait',
  footnotes: PackPage['footnotes'] = [],
): UnnumberedPage {
  return { title, navLabel, section, orientation, density, blocks, footnotes };
}
