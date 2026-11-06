/**
 * The figure fit measures a row against the width of the sheet it prints on, so the components must tell it
 * which sheet that is: a row too wide for portrait can be ordinary on landscape, and the other way round is
 * never true. Without the orientation every sheet was measured as portrait.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PackBlocks } from '@/components/accounting/packs/pages/PackBlocks';
import { kpiFit, tableFit } from '@/modules/accounting/services/packs/pages/packFigureFit';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoWithoutBudget, SCALE, withWidenedKpi, withWidenedTable } from '../../services/packs/fixtures/widenedFigures';

const range = Array.from({ length: 30 }, (unused, i) => i + 4);
const fitted = (page: PackPage, selector: string) => render(<PackBlocks page={page} scale={SCALE} />).container.querySelector(selector)?.classList.contains('is-fitted');

describe('a figure row on a landscape sheet', () => {
  it('a table fitted to a smaller size on portrait is left at the ordinary size on landscape', () => {
    const digits = range.find((d) => {
      const { table } = withWidenedTable(demoWithoutBudget(), d);
      return tableFit(table, SCALE).px !== null && tableFit(table, SCALE, 'landscape').px === null;
    })!;
    expect(digits).toBeDefined();
    const { doc, index } = withWidenedTable(demoWithoutBudget(), digits);
    const page = doc.pages[index]!;
    expect(fitted({ ...page, orientation: 'portrait' }, '.pack-table')).toBe(true);
    expect(fitted({ ...page, orientation: 'landscape' }, '.pack-table')).toBe(false);
  });

  it('a KPI row fitted to a smaller size on portrait is left at the ordinary size on landscape', () => {
    const digits = range.find((d) => {
      const { tiles } = withWidenedKpi(demoWithoutBudget(), d);
      return kpiFit(tiles, SCALE).px !== null && kpiFit(tiles, SCALE, 'landscape').px === null;
    })!;
    expect(digits).toBeDefined();
    const { doc, index } = withWidenedKpi(demoWithoutBudget(), digits);
    const page = doc.pages[index]!;
    expect(fitted({ ...page, orientation: 'portrait' }, '.pack-kpi-tiles')).toBe(true);
    expect(fitted({ ...page, orientation: 'landscape' }, '.pack-kpi-tiles')).toBe(false);
  });
});
