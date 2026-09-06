/**
 * A superscript reference to a numbered footnote — the inline half of the
 * pair; `FootnoteList` prints the footnote text itself at the foot of the
 * page. Renders nothing when there is no footnote to point at, so a caller
 * can pass a `number | null` index (e.g. `PackKpiTile.trendFootnote`)
 * straight through without an extra guard at the call site.
 */
export interface FootnoteMarkerProps {
  number: number | null;
}

export function FootnoteMarker({ number }: FootnoteMarkerProps) {
  if (number === null) return null;
  return (
    <sup className="pack-footnote-marker" aria-label={`footnote ${number}`}>
      {number}
    </sup>
  );
}
