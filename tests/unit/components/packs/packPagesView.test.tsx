import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { countPageModelCharts } from '@/components/accounting/packs/usePrintMode';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

const doc = {
  packType: 'board' as const, packLabel: 'Board Pack', companyName: 'Demo',
  period: '2026', generatedAt: '2026-09-07T00:00:00Z', draft: false,
  brand: { primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', logoUrl: null,
           footerText: null, primaryInk: '#ffffff' },
  pages: [],
};

// Real renderChartSvg output, not a forged cast — the whole point of
// TrustedChartSvg is that only this function's output satisfies the type,
// so a test fixture claiming otherwise should have to go through it too.
const svg = () => renderChartSvg({}, { widthMm: 10, heightMm: 10 });

afterEach(() => {
  vi.useRealTimers();
});

describe('PackPagesView', () => {
  it('renders data-print-ready="false" while the document is null', () => {
    const { container } = render(<PackPagesView document={null} />);
    expect(container.querySelector('[data-print-ready="false"]')).not.toBeNull();
  });

  it('becomes data-print-ready="true" once the document has loaded and there are no charts', () => {
    const { container } = render(<PackPagesView document={doc} />);
    expect(container.querySelector('[data-print-ready="true"]')).not.toBeNull();
  });

  it('stays not ready with a chart pending, then flips once the expected SVGs are actually drawn', () => {
    // expectedCharts > 0: this is the polling branch of usePrintReady, the
    // one a real board pack always exercises — the early-return shortcut
    // (expectedCharts === 0) is a different path, covered separately above,
    // and proves nothing about this one.
    vi.useFakeTimers();
    const pages: PackPage[] = [{ number: 1, title: 'Revenue up 12%', section: 'Performance',
      orientation: 'portrait', density: 'high', footnotes: [],
      blocks: [{ kind: 'chart', chart: { id: 'c1', title: 'Revenue up 12%', kind: 'line', svg: svg(), heightMm: 48 } }] }];
    const { container } = render(<PackPagesView document={{ ...doc, pages }} />);

    // PackPageFrame renders no block content (a later task's job), so
    // nothing satisfies `[data-pack-chart] svg` yet — the pack must not
    // claim to be ready with its one expected chart missing.
    act(() => { vi.advanceTimersByTime(500); });
    expect(container.querySelector('[data-print-ready="true"]')).toBeNull();
    expect(container.querySelector('[data-print-ready="false"]')).not.toBeNull();

    // Simulate the future block renderer drawing the expected chart.
    const chartHost = document.createElement('div');
    chartHost.setAttribute('data-pack-chart', '');
    chartHost.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    container.querySelector('.pack-page')!.appendChild(chartHost);

    act(() => { vi.advanceTimersByTime(100); });
    expect(container.querySelector('[data-print-ready="true"]')).not.toBeNull();

    chartHost.remove();
  });

  it('injects the brand style block', () => {
    const { container } = render(<PackPagesView document={doc} />);
    expect(container.querySelector('style')?.innerHTML).toContain('--pack-brand: #1a3a5c');
  });

  it('renders one .pack-page element per model page', () => {
    const pages = [1, 2, 3].map((number) => ({
      number, title: `Page ${number}`, section: 'Performance' as const,
      orientation: 'portrait' as const, density: 'high' as const, blocks: [], footnotes: [],
    }));
    const { container } = render(<PackPagesView document={{ ...doc, pages }} />);
    expect(container.querySelectorAll('.pack-page')).toHaveLength(3);
  });

  it('renders the page title so a deleted header is not invisible to the suite', () => {
    const pages: PackPage[] = [{ number: 1, title: 'Revenue up 12% against budget',
      section: 'Performance', orientation: 'portrait', density: 'high', blocks: [], footnotes: [] }];
    render(<PackPagesView document={{ ...doc, pages }} />);
    expect(screen.getByText('Revenue up 12% against budget')).toBeInTheDocument();
  });

  it('marks a landscape page with the named-page attribute, not a transport flag', () => {
    const pages = [{ number: 10, title: 'Trends', section: 'Performance' as const,
      orientation: 'landscape' as const, density: 'high' as const, blocks: [], footnotes: [] }];
    const { container } = render(<PackPagesView document={{ ...doc, pages }} />);
    expect(container.querySelector('[data-print-landscape]')).not.toBeNull();
  });

  it('does not mark a portrait page with the named-page attribute', () => {
    const pages = [{ number: 1, title: 'Highlights', section: 'Performance' as const,
      orientation: 'portrait' as const, density: 'high' as const, blocks: [], footnotes: [] }];
    const { container } = render(<PackPagesView document={{ ...doc, pages }} />);
    expect(container.querySelector('[data-print-landscape]')).toBeNull();
  });

  it('shows a draft watermark only on a draft pack', () => {
    const { rerender, container } = render(<PackPagesView document={{ ...doc, draft: true }} />);
    expect(container.querySelector('[data-pack-draft]')).not.toBeNull();
    rerender(<PackPagesView document={doc} />);
    expect(container.querySelector('[data-pack-draft]')).toBeNull();
  });
});

describe('countPageModelCharts', () => {
  const basePage = {
    number: 1, title: 'Trends', section: 'Performance' as const,
    orientation: 'portrait' as const, density: 'high' as const, footnotes: [],
  };

  it('counts one per chart block and one per small-multiples panel', () => {
    const pages: PackPage[] = [
      { ...basePage, blocks: [
        { kind: 'chart', chart: { id: 'c1', title: 'x up 1%', kind: 'line', svg: svg(), heightMm: 48 } },
        { kind: 'smallMultiples', panels: [
          { id: 'p1', title: 'a up 1%', kind: 'line', svg: svg(), heightMm: 48 },
          { id: 'p2', title: 'b up 1%', kind: 'line', svg: svg(), heightMm: 48 },
        ] },
      ] },
    ];
    expect(countPageModelCharts(pages)).toBe(3);
  });

  it('counts zero for a page with no chart-shaped blocks', () => {
    expect(countPageModelCharts([{ ...basePage, blocks: [] }])).toBe(0);
  });
});
