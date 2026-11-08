/**
 * THE FIGURE SIZES THE MODEL USES ARE THE ONES THE STYLESHEET PRINTS.
 *
 * `packFigureFit.ts` holds the ordinary sizes and the floors (22pt / 12pt for a KPI figure, 9pt / 7.5pt for a
 * table figure); the stylesheet holds the ordinary sizes too (`font-size: 22pt` on `.pack-kpi-value`, `9pt` on
 * `.pack-table`) and takes a fitted size only from `--pack-fit-size`, which the model sets. A CSS file cannot
 * import the constants, so this holds the two together: change one and this goes red. The floors live in the
 * model alone (a fitted size is never set below them and a row that needs less is refused).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KPI_FIGURE_FLOOR_PT, KPI_FIGURE_MAX_PT, TABLE_FIGURE_FLOOR_PT, TABLE_FIGURE_MAX_PT,
} from '@/modules/accounting/services/packs/pages/packFigureFit';
import { GUTTER_MM } from '@/modules/accounting/services/packs/pages/packDisclosureHeight';
import { ptToPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';

const css = (file: string) => readFileSync(path.resolve(__dirname, '../../../../styles', file), 'utf8');

describe('the stylesheet\'s figure sizes', () => {
  it('KPI figures print at the ordinary size unless a row is fitted, and a fitted row takes its size from the model', () => {
    const page = css('packPrintPage.css');
    expect(page).toMatch(new RegExp(`\\.pack-kpi-value \\{[^}]*font-size: ${KPI_FIGURE_MAX_PT}pt;`));
    expect(page).toContain('.pack-kpi-tiles.is-fitted .pack-kpi-value { font-size: var(--pack-fit-size); }');
  });

  it('table figures print at the ordinary size unless a table is fitted, and a fitted table takes its size from the model', () => {
    expect(css('packPrintTablesAndProse.css')).toMatch(new RegExp(`\\.pack-table \\{[^}]*font-size: ${TABLE_FIGURE_MAX_PT}pt;`));
    expect(css('packPrintTablesAndProse.css')).toContain('.pack-table.is-fitted td:not(:first-child) { font-size: var(--pack-fit-size); }');
  });

  it('the floors are whole pixel sizes (a fitted size is whole by construction) and below the ordinary sizes', () => {
    expect(ptToPx(KPI_FIGURE_FLOOR_PT)).toBe(16);
    expect(ptToPx(TABLE_FIGURE_FLOOR_PT)).toBe(10);
    expect(KPI_FIGURE_FLOOR_PT).toBeLessThan(KPI_FIGURE_MAX_PT);
    expect(TABLE_FIGURE_FLOOR_PT).toBeLessThan(TABLE_FIGURE_MAX_PT);
  });

  it('the KPI grid\'s gap the model uses is the stylesheet\'s --pack-gutter, and the table cell side is its 2mm', () => {
    expect(css('packPrintPage.css')).toContain(`--pack-gutter: ${GUTTER_MM}mm;`);
    expect(css('packPrintTablesAndProse.css')).toContain('padding: 1.2mm 2mm;');
    expect(css('packPrintTablesAndProse.css')).toContain('padding: 1.5mm 2mm;');
  });
});
