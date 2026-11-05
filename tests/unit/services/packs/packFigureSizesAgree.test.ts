/**
 * THE FIGURE SIZES THE MODEL USES ARE THE ONES THE STYLESHEET PRINTS.
 *
 * `packFigureFloor.ts` holds the ceilings and floors (22/12pt for a KPI figure, 9/7.5pt for a table figure)
 * and the stylesheet repeats them in its `font-size` rules; the model's refusal, the KPI row fit and the
 * height model all read the TS constants. A CSS file cannot import them, so this holds the two together:
 * change one and this goes red.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KPI_FIGURE_FLOOR_PT, KPI_FIGURE_MAX_PT, TABLE_FIGURE_FLOOR_PT, TABLE_FIGURE_MAX_PT,
} from '@/modules/accounting/services/packs/pages/packFigureFloor';
import { TABLE_CELL_PADDING_MM, TABLE_LABEL_COLUMN_MM } from '@/components/accounting/packs/primitives/packFigureFit';

const css = (file: string) => readFileSync(path.resolve(__dirname, '../../../../styles', file), 'utf8');

describe('the stylesheet\'s figure sizes', () => {
  it('KPI figures: max(floor, min(ceiling, fit))', () => {
    expect(css('packPrintPage.css')).toContain(`font-size: max(${KPI_FIGURE_FLOOR_PT}pt, min(${KPI_FIGURE_MAX_PT}pt,`);
  });

  it('table figures: max(floor, min(ceiling, fit)), with the label column and cell padding the TS names', () => {
    const rule = css('packPrintTablesAndProse.css');
    expect(rule).toContain(`font-size: max(${TABLE_FIGURE_FLOOR_PT}pt, min(${TABLE_FIGURE_MAX_PT}pt,`);
    expect(rule).toContain(`100cqw - ${TABLE_LABEL_COLUMN_MM}mm - var(--pack-fit-cols, 0) * ${TABLE_CELL_PADDING_MM}mm`);
  });
});
