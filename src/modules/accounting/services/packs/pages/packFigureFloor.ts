/**
 * A FIGURE THE SHEET CAN ONLY HOLD BELOW THE SMALLEST TEXT THE PACK PRINTS IS NOT PRINTED.
 *
 * KPI figures and statement-table figures shrink to fit their row (`packFigureFit.ts`, the `font-size`
 * rules in `styles/packPrintPage.css` and `packPrintTablesAndProse.css`), never below a floor: 12pt for a
 * KPI figure, 7.5pt for a table figure (the footnotes' size, the pack's smallest text). Where the figures
 * are so wide that even the floor does not fit the measure, the stylesheet sets the floor and the row
 * runs past the sheet's right edge, where content is not small but gone. This repeats the stylesheet's
 * arithmetic and refuses such a pack rather than print it. It is the only honest answer left at that
 * point: the figures cannot be shortened, and the 12 sheets cannot grow.
 *
 * Reached only at figures beyond R10 trillion of revenue in R'000 (the demo company scaled by 1e8).
 */
import { type FigureCell, tableColumnTexts, TABLE_CELL_PADDING_MM, widestPerColumnEms } from '@/components/accounting/packs/primitives/packFigureFit';
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import type { MoneyScale } from '@/lib/format/money';
import { PackRefusal } from '../packRefusal';
import { GUTTER_MM } from './packDisclosureHeight';
import type { PackPage } from './packPageModel';
import { MIN_LABEL_SHARE } from './packTableLabelShare';
import { PAGE_WIDTH_MM, PT_MM, type PageOrientation } from './packTextMetrics';

export const KPI_FIGURE_FLOOR_PT = 12;
export const TABLE_FIGURE_FLOOR_PT = 7.5;
/** The sizes figures print at where they fit. ONE source with the stylesheet: `packFigureSizesAgree.test.ts` reads the CSS. */
export const KPI_FIGURE_MAX_PT = 22;
export const TABLE_FIGURE_MAX_PT = 9;
const KPI_COLUMNS = 4;

/**
 * The size, in points, a table's figures need at the NARROWEST label column the page model allows
 * (`MIN_LABEL_SHARE`, a tenth of the measure: one short word per line), capped at the ceiling.
 *
 * Not the stylesheet's 30mm: the stylesheet reserves 30mm for the label so that figures shrink early and
 * labels keep their lines, but at the floor Chromium squeezes the label column below that rather than
 * overflow (the label is the one column allowed to wrap). The pack is refused only where even that
 * squeeze cannot hold the figures at the floor.
 */
export function tableFigurePt(columnTexts: ReadonlyArray<ReadonlyArray<FigureCell>>, orientation: PageOrientation = 'portrait'): number | null {
  if (columnTexts.length === 0) return null;
  const roomMm = PAGE_WIDTH_MM[orientation] * (1 - MIN_LABEL_SHARE) - columnTexts.length * TABLE_CELL_PADDING_MM;
  return Math.min(TABLE_FIGURE_MAX_PT, roomMm / widestPerColumnEms(columnTexts) / PT_MM);
}

/** The same for a KPI tile row (tile i sits in column i % 4). */
export function kpiFigurePt(texts: ReadonlyArray<string | null>, orientation: PageOrientation = 'portrait'): number | null {
  const byColumn: string[][] = Array.from({ length: KPI_COLUMNS }, () => []);
  texts.forEach((text, i) => { if (text !== null) byColumn[i % KPI_COLUMNS]!.push(text); });
  const ems = widestPerColumnEms(byColumn, 'kpi');
  if (ems === 0) return null;
  const roomMm = PAGE_WIDTH_MM[orientation] - (KPI_COLUMNS - 1) * GUTTER_MM;
  return Math.min(KPI_FIGURE_MAX_PT, roomMm / ems / PT_MM);
}

/** The first block of `page` whose figures cannot be set at their floor (3% under it is tolerated: the ruler carries 10% headroom), with the size they would need. */
export function unreadableBlock(page: Omit<PackPage, 'number'>, scale: MoneyScale): { pt: number; floor: number } | null {
  const orientation: PageOrientation = page.orientation;
  for (const block of page.blocks) {
    let pt: number | null = null;
    let floor = 0;
    if (block.kind === 'table') {
      pt = tableFigurePt(tableColumnTexts(block.table, scale), orientation);
      floor = TABLE_FIGURE_FLOOR_PT;
    } else if (block.kind === 'kpiTiles') {
      pt = kpiFigurePt(block.tiles.map((t) => (t.figure.value === null ? null : formatFigureText(t.figure, scale))), orientation);
      floor = KPI_FIGURE_FLOOR_PT;
    }
    if (pt !== null && pt < floor * 0.97) return { pt, floor };
  }
  return null;
}

/** Refuse a pack with a figure the sheet cannot hold at its floor. */
export function assertFiguresReadable(pages: ReadonlyArray<Omit<PackPage, 'number'>>, scale: MoneyScale): void {
  for (const page of pages) {
    const found = unreadableBlock(page, scale);
    if (found !== null) {
      const { pt, floor } = found;
      throw new PackRefusal(
        `assertFiguresReadable: "${page.navLabel}" needs its figures at ${pt.toFixed(1)}pt and the floor is ${floor}pt; `
          + 'refusing to print figures smaller than the pack\'s smallest text, or past the sheet\'s edge.',
        `The "${page.navLabel}" page of this pack has figures too wide to print legibly on one sheet. The pack `
          + 'has not been produced, rather than printing them unreadably small or cut off at the edge of the page. '
          + 'Your figures are not the problem and nothing has been left out of them — please contact support with '
          + 'the period you asked for.',
      );
    }
  }
}
