/**
 * HOW A ROW OF NOWRAP FIGURES TELLS THE PRINT STYLESHEET HOW WIDE IT IS.
 *
 * A KPI tile's figure and a statement table's figure cells are `white-space: nowrap` on purpose: a
 * number split across two lines is a number a reader has to reassemble. The price is that the widest
 * figure of a column sets that column's width, and at a large enough scale the columns together are
 * wider than the sheet. Content past the sheet's right edge is not short, it is gone: page 3's tile
 * row did it from a net profit of (13 350 000) (R'000), page 6's eight-column table at (297 000 000).
 *
 * So the figures shrink to fit instead, and only then. The component states, as a custom property, the
 * summed widths of the widest figure of each column in ems of the pack's own ruler (`textWidthEms`);
 * the stylesheet divides the room the row has by that and takes the smaller of the result and the
 * size the figure normally has. Where the figures fit at their normal size the result is the normal
 * size and the page prints exactly as it did. No figure, label or unit changes.
 */
import type { CSSProperties } from 'react';
import { textWidthEms } from '@/modules/accounting/services/packs/pages/packTextMetrics';

/** A style object carrying CSS custom properties, which React's `CSSProperties` does not name. */
export type FitStyle = CSSProperties & Record<`--${string}`, string | number>;

/** The summed widths, in ems, of the widest text in each column. */
export function widestPerColumnEms(columns: ReadonlyArray<ReadonlyArray<string>>): number {
  return columns.reduce(
    (sum, texts) => sum + texts.reduce((widest, text) => Math.max(widest, textWidthEms(text)), 0),
    0,
  );
}

/** A KPI tile row: tile `i` sits in column `i % columns`. */
export function kpiFitStyle(texts: ReadonlyArray<string | null>, columns = 4): FitStyle {
  const byColumn: string[][] = Array.from({ length: columns }, () => []);
  texts.forEach((text, i) => { if (text !== null) byColumn[i % columns]!.push(text); });
  return { '--pack-fit-ems': Number(widestPerColumnEms(byColumn).toFixed(2)) };
}

/** A statement table: one list of printed cell texts per data column. */
export function tableFitStyle(columnTexts: ReadonlyArray<ReadonlyArray<string>>): FitStyle {
  return {
    '--pack-fit-ems': Number(widestPerColumnEms(columnTexts).toFixed(2)),
    '--pack-fit-cols': columnTexts.length,
  };
}
