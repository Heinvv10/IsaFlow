/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * THE MANAGEMENT PACK'S BRIDGE IS DRAWN IN ONE KNOWN RECTANGLE.
 *
 * Its layout — the axis, the room every figure gets, which figures are
 * staggered clear of their neighbours — is chosen for a box, so the box has
 * to be the one drawn. At a container's width the chart was 360px on a narrow
 * window and ECharts squeezed the plot to nothing under its own axis labels.
 * Three facts make the box fixed, and each is pinned here:
 *   - the print view's root is `max-w-[190mm]`, 718 CSS pixels;
 *   - the waterfall section is a landscape sheet, wider than that;
 *   - the chart's wrapper is given that width outright, not `100%`, and the
 *     option is laid out for the same box.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';
import { isLandscapeSection } from '@/modules/accounting/services/packs/packSections';

const drawn = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('@/components/charts/EChartClient', () => ({
  EChartClient: (props: { option: unknown; height?: number }) => { drawn.options.push(props.option); return <div data-testid="echart" data-height={props.height} />; },
}));

import { PackPrintView } from '@/components/accounting/packs/PackPrintView';
import { LEGACY_WATERFALL_BOX, legacyWaterfallOption } from '@/components/accounting/packs/PackSectionView';

afterEach(() => {
  cleanup();
  drawn.options.length = 0;
  document.documentElement.className = '';
  window.localStorage.clear();
});

const PX_PER_MM = 96 / 25.4;
const A4_LANDSCAPE_MEASURE_MM = 297 - 18 - 18;
const STEPS = [
  { label: 'Revenue', start: 0, end: 101_400, value: 101_400, isSubtotal: false, color: 'green' },
  { label: 'Cost of Sales', start: 101_400, end: -1_329_181, value: -1_430_581, labelValue: 1_430_581, isSubtotal: false, color: 'red' },
  { label: 'Gross Profit', start: 0, end: -1_329_181, value: -1_329_181, isSubtotal: true, color: 'teal' },
  { label: 'Operating Expenses', start: -1_329_181, end: -1_556_052, value: -226_871, labelValue: 226_871, isSubtotal: false, color: 'red' },
  { label: 'Net Profit', start: 0, end: -1_556_052, value: -1_556_052, isSubtotal: true, color: 'red' },
];
const doc: PackDocument = {
  packType: 'management', companyName: 'ISAFlow Demo', period: '2026-01-01 to 2026-09-05', generatedAt: '2026-09-06T08:00:00.000Z',
  sections: [{ type: 'waterfall', title: 'Profit Bridge', landscape: true, blocks: [{ kind: 'waterfall', steps: STEPS }] }],
} as PackDocument;

describe('the management pack bridge\'s box', () => {
  it('is the print view\'s own measure: 190mm, on a sheet wide enough to hold it', () => {
    const { container } = render(<PackPrintView document={doc} />);
    expect(container.firstElementChild!.className).toContain('max-w-[190mm]');
    expect(LEGACY_WATERFALL_BOX.widthPx).toBe(Math.floor(190 * PX_PER_MM));
    expect(isLandscapeSection('waterfall')).toBe(true);
    expect(A4_LANDSCAPE_MEASURE_MM).toBeGreaterThan(190);
  });

  it('is the width the chart is given outright, and the height it is drawn at', () => {
    const { container } = render(<PackPrintView document={doc} />);
    const chart = container.querySelector<HTMLElement>('[data-pack-chart]')!;
    expect(chart.style.width).toBe(`${LEGACY_WATERFALL_BOX.widthPx}px`);
    expect(chart.className).not.toContain('w-full');
    expect(chart.querySelector('[data-testid="echart"]')!.getAttribute('data-height')).toBe(String(LEGACY_WATERFALL_BOX.heightPx));
  });

  it('is the box the option is laid out for', () => {
    render(<PackPrintView document={doc} />);
    const strip = (o: unknown) => JSON.stringify(o, (_k, v: unknown) => (typeof v === 'function' ? 'fn' : v));
    expect(drawn.options).toHaveLength(1);
    expect(strip(drawn.options[0])).toBe(strip(legacyWaterfallOption(STEPS as never, LEGACY_WATERFALL_BOX)));
    // And a different box is a different layout — the comparison can fail.
    expect(strip(drawn.options[0])).not.toBe(strip(legacyWaterfallOption(STEPS as never, { heightPx: 240, widthPx: 360 })));
  });
});
