/**
 * The numbered footnote list at the foot of a page or a block. Same markup
 * `PackPageFrame` already inlines for a page's own footnotes, pulled out
 * here so a block that carries its own footnotes (rather than the whole
 * page's) can render them without duplicating that `<ol>`.
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
        <li key={footnote.number}>{footnote.text}</li>
      ))}
    </ol>
  );
}
