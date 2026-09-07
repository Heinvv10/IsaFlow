/**
 * The numbered footnote list at the foot of a page or a block. `PackPageFrame`
 * renders a page's own footnotes through this component too, so there is one
 * `<ol>` in the pack and not two that can drift.
 *
 * THE NUMBER IS PRINTED, NOT LEFT TO THE LIST MARKER. Tailwind's preflight
 * sets `ol { list-style: none; padding: 0 }` on every list in the app, so the
 * `<ol>`'s own numbering drew nothing — sheet 3's five tile captions carried a
 * `FootnoteMarker` superscript pointing at an unlabelled grey block, and the
 * reference resolved to nothing on the paper. Rendering the number explicitly
 * also puts it in the PDF's text layer, which a list marker (generated
 * content) is not guaranteed to reach.
 *
 * Numbers here and letters under a table is the pack's deliberate two-series
 * scheme, not an inconsistency: `noteMark` (`notMeaningfulNotes.tsx`) letters
 * a TABLE's `n/m` reasons precisely so a second numeric series does not read
 * as a continuation of the page's own footnotes.
 */
import type { PackFootnote } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface FootnoteListProps {
  footnotes: PackFootnote[];
}

export function FootnoteList({ footnotes }: FootnoteListProps) {
  if (footnotes.length === 0) return null;
  return (
    <ol className="pack-footnotes">
      {footnotes.map((footnote) => (
        <li key={footnote.number}>
          <span className="pack-footnote-number">{footnote.number}</span>
          <span>{footnote.text}</span>
        </li>
      ))}
    </ol>
  );
}
