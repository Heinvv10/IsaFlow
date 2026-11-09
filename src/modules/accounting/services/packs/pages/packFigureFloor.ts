/**
 * A FIGURE THE SHEET CANNOT HOLD AT THE PACK'S SMALLEST TEXT IS NOT PRINTED.
 *
 * `packFigureFit.ts` decides, per KPI row and per statement table, whether the figures fit at their ordinary
 * size, at a smaller one no smaller than the floor, or at none. This refuses the pack for the last: the figures
 * cannot be shortened and the 12 sheets cannot grow, so the only alternatives are printing them past the
 * sheet's edge (content gone, silently) or smaller than the pack's smallest text.
 */
import type { MoneyScale } from '@/lib/format/money';
import { PackRefusal } from '../packRefusal';
import { kpiFit, refusingLabel, tableFit } from './packFigureFit';
import type { PackPage } from './packPageModel';

export {
  KPI_FIGURE_FLOOR_PT, KPI_FIGURE_MAX_PT, TABLE_FIGURE_FLOOR_PT, TABLE_FIGURE_MAX_PT,
} from './packFigureFit';

/**
 * The first block of `page` whose figures fit at no size down to their floor; for a table, the row label that keeps it
 * from fitting, where it is one (`packFigureFit.refusingLabel`: a character the print cannot break, too wide).
 */
export function unreadableBlock(page: Omit<PackPage, 'number'>, scale: MoneyScale): { kind: 'table' | 'kpi'; label?: string } | null {
  for (const block of page.blocks) {
    if (block.kind === 'table' && !tableFit(block.table, scale, page.orientation).fits) {
      const label = refusingLabel(block.table, scale, page.orientation);
      return label === null ? { kind: 'table' } : { kind: 'table', label };
    }
    if (block.kind === 'kpiTiles') {
      if (!kpiFit(block.tiles, scale, page.orientation).fits) return { kind: 'kpi' };
    }
  }
  return null;
}

/** Refuse a pack with a figure row the sheet cannot hold at its floor. */
export function assertFiguresReadable(pages: ReadonlyArray<Omit<PackPage, 'number'>>, scale: MoneyScale): void {
  for (const page of pages) {
    const found = unreadableBlock(page, scale);
    if (found === null) continue;
    if (found.label !== undefined) {
      throw new PackRefusal(
        `assertFiguresReadable: "${page.navLabel}": a table whose row label "${found.label}" holds a character the print `
          + 'cannot break across lines, wider than the room its figures leave; refusing to print the label over the figures.',
        `The "${page.navLabel}" page of this pack has a row label, "${found.label}", holding a character (such as a `
          + 'combined emoji or a stacked letter) too wide to sit beside the figures on one sheet: a character is never '
          + 'split across lines. The pack has not been produced, rather than print that label over the figures. Your '
          + 'figures are not the problem — please contact support with the period you asked for.',
      );
    }
    throw new PackRefusal(
      `assertFiguresReadable: "${page.navLabel}": a ${found.kind === 'kpi' ? 'KPI row' : 'table'} whose figures fit at no `
        + 'size down to the pack\'s smallest text (12pt KPI, 7.5pt table); refusing to print them past the sheet\'s edge.',
      `The "${page.navLabel}" page of this pack has figures too wide to print legibly on one sheet. The pack `
        + 'has not been produced, rather than printing them unreadably small or cut off at the edge of the page. '
        + 'Your figures are not the problem and nothing has been left out of them — please contact support with '
        + 'the period you asked for.',
    );
  }
}
