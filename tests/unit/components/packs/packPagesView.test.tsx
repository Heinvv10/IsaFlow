import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { countPageModelCharts } from '@/components/accounting/packs/usePrintMode';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

const doc = {
  packType: 'board' as const, packLabel: 'Board Pack', companyName: 'Demo',
  period: '2026', generatedAt: '2026-09-07T00:00:00Z', draft: false,
  brand: { primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', logoUrl: null,
           footerText: null, primaryInk: '#ffffff' },
  // Task 18: the view now formats figures, so it needs the document's scale
  // and refuses to render without one it recognises.
  numberConvention: { scale: "R'000", currency: 'ZAR' },
  basisOfPreparation: { standard: 'IFRS for SMEs', sourceSystem: 'IsaFlow general ledger',
                        extractedAt: '2026-09-07T00:00:00Z', ledgerVersion: 'v1' },
  provenance: new PackFigureProvenance(),
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

  // ASYNC NOW, AND IT HAS TO BE. The gate also waits for the pack's font
  // faces (`packFontsLoaded`), which is a promise even where — as under
  // happy-dom — there is no font-loading API to ask. A render followed by a
  // synchronous assertion would read the frame before that settles.
  it('becomes data-print-ready="true" once the document has loaded and there are no charts', async () => {
    const { container } = render(<PackPagesView document={doc} />);
    await act(async () => {});
    expect(container.querySelector('[data-print-ready="true"]')).not.toBeNull();
  });

  it('draws the declared chart and becomes ready only once its SVG is in the DOM', async () => {
    // The polling branch of usePrintReady (expectedCharts > 0), which is the
    // one a real board pack always exercises — the early-return shortcut
    // (expectedCharts === 0) is a different path, covered separately above.
    //
    // Task 18 changed what this proves. Before it, PackPageFrame rendered no
    // block content, so the chart had to be faked into the DOM by hand and
    // the test could only show the gate NOTICING one. Now the block renderer
    // draws it, so what is checked is the real pair: the model declares one
    // chart, the DOM holds exactly one `[data-pack-chart] svg`, and the pack
    // is ready. A renderer that dropped the chart would leave the count at 0
    // and the pack permanently not-ready, which is the failure that matters.
    const pages: PackPage[] = [{ number: 3, title: 'Revenue up 12%', section: 'Performance',
      orientation: 'portrait', density: 'high', footnotes: [],
      blocks: [{ kind: 'chart', chart: { id: 'c1', title: 'Revenue up 12%', kind: 'line', svg: svg(), heightMm: 48 } }] }];
    const { container } = render(<PackPagesView document={{ ...doc, pages }} />);
    await act(async () => {});

    expect(container.querySelectorAll('[data-pack-chart] svg')).toHaveLength(1);
    expect(container.querySelector('[data-print-ready="true"]')).not.toBeNull();
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
    // Page 3, not page 1: page 1 is the COVER, whose headline is the company's
    // legal name (PackCoverV2), not `page.title`.
    const pages: PackPage[] = [{ number: 3, title: 'Revenue up 12% against budget',
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
    const pages = [{ number: 3, title: 'Highlights up 4%', section: 'Performance' as const,
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
