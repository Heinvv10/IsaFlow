/**
 * The renderer half of "a chart is drawn on the page's measure".
 *
 * `packChartMeasure.test.ts` proves the SVG is RENDERED at `plotMm`. This
 * proves the box it is given on the page is that same number — because the
 * two being different is the whole defect: an SVG whose viewBox does not
 * match its box is letterboxed, scaled down uniformly and centred, so it
 * loses width in proportion to how tall its caption happened to wrap. The
 * figure used to carry a fixed height and `.pack-chart-svg` took `flex: 1`
 * of whatever the caption left, which is a box no model can state.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PackChartBlock, PackSmallMultiples } from '@/components/accounting/packs/pages/PackChartBlock';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { liveDemoShortPanelsInput } from '../../services/packs/fixtures/liveDemoBoardPack';
import type { PackChartSpec } from '@/modules/accounting/services/packs/pages/packChartModel';

function blocks(): { charts: PackChartSpec[]; panels: PackChartSpec[] } {
  const charts: PackChartSpec[] = [];
  const panels: PackChartSpec[] = [];
  for (const page of buildBoardPackPages(liveDemoShortPanelsInput).pages) {
    for (const block of page.blocks) {
      if (block.kind === 'chart') charts.push(block.chart);
      if (block.kind === 'smallMultiples') panels.push(...block.panels);
    }
  }
  return { charts, panels };
}

describe('a chart figure sizes its plot from the model', () => {
  it('gives a full-width chart the plot box its SVG was rendered at', () => {
    const { charts } = blocks();
    expect(charts.length, 'no full-width chart in this pack').toBeGreaterThan(0);
    for (const chart of charts) {
      const { container } = render(<PackChartBlock chart={chart} />);
      const figure = container.querySelector('figure')!;
      expect(figure.style.getPropertyValue('--pack-chart-plot-mm'), chart.id)
        .toBe(`${chart.plotMm}mm`);
      // NO FIXED FIGURE HEIGHT. That is what left the plot box to the
      // caption; the figure is its caption plus a stated plot now.
      expect(figure.style.height, `${chart.id} still fixes the figure height`).toBe('');
    }
  });

  it('gives a panel the same treatment', () => {
    const { panels } = blocks();
    expect(panels.length, 'no small multiples in this pack').toBeGreaterThan(0);
    const { container } = render(<PackSmallMultiples panels={panels} />);
    const figures = [...container.querySelectorAll('figure')];
    expect(figures).toHaveLength(panels.length);
    figures.forEach((figure, i) => {
      expect(figure.style.getPropertyValue('--pack-chart-plot-mm'), panels[i]!.id)
        .toBe(`${panels[i]!.plotMm}mm`);
    });
  });
});
