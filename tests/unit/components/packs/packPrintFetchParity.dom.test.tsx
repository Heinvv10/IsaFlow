/**
 * The printed page's fetches, against the list the print token authorises.
 *
 * renderPagePdf stubs every /api/* call NOT in `packPrintApiPaths` with an
 * empty envelope, so a path the page fetches that is missing from that list
 * does not 401 — it silently returns nothing, and the PDF ships showing a
 * loading state. Nothing else in the pipeline compares the two lists, so
 * this does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import type { ReportPack } from '@/modules/accounting/services/reports/reportPackService';

vi.mock('@/components/charts/EChartClient', () => ({ EChartClient: () => <div data-testid="echart" /> }));

import { PackPrintPage } from '@/components/accounting/packs/PackPrintPage';
import { PackPagesPrintPage } from '@/components/accounting/packs/PackPagesPrintPage';
import { packPrintApiPaths } from '@/modules/accounting/services/packs/packSections';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { serialisePackPagesDocument } from '@/modules/accounting/services/packs/pages/packDocumentWire';
import { demoInput } from '../../services/packs/fixtures/boardPackInputs';

const PACK: ReportPack = {
  type: 'management',
  companyName: 'ISAFlow Demo',
  period: '2026-01-01 to 2026-08-31',
  generatedAt: '2026-09-06T08:00:00.000Z',
  sections: [
    {
      type: 'income_statement',
      title: 'Income Statement',
      data: {
        revenue: 1000, costOfSales: 400, grossProfit: 600, otherIncome: 0,
        operatingExpenses: 200, operatingProfit: 400, otherExpenses: 0,
        netProfit: 400, grossMargin: 60, netMargin: 40,
      },
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.className = '';
  window.localStorage.clear();
});

describe('the printed pack page fetches exactly the paths the print token authorises', () => {
  it('calls the pack endpoint and the trend endpoint, and nothing else', async () => {
    const called: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const { pathname } = new URL(url, 'http://localhost');
      called.push(pathname);
      const data = pathname === '/api/accounting/reports-pack' ? { pack: PACK } : [];
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    render(<PackPrintPage packType="management" from="2026-01-01" to="2026-08-31" />);

    await waitFor(() => expect(called.length).toBe(2));
    expect([...called].sort()).toEqual([...packPrintApiPaths('management')].sort());
  });
});

/**
 * The board pack prints a different page off a different list. Its charts are
 * rendered by `renderChartSvg` — `node:crypto` plus ECharts, neither of which
 * a browser can run — so the whole document is composed server-side and
 * arrives in ONE fetch. `reports-pack` and the trend series are therefore not
 * merely unused there; they are unauthorised, and this is what says so.
 */
describe('the printed BOARD pack fetches exactly its own authorised path', () => {
  it('calls the pages endpoint, and nothing else', async () => {
    const called: string[] = [];
    const document = serialisePackPagesDocument(buildBoardPackPages(demoInput));

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const { pathname } = new URL(url, 'http://localhost');
      called.push(pathname);
      // Through a real JSON round trip, like the wire: a stub that handed the
      // component the live object would never exercise the brand's decay.
      return new Response(JSON.stringify({ success: true, data: document }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    render(<PackPagesPrintPage packType="board" from="2026-03-01" to="2026-08-31" />);

    await waitFor(() => expect(called.length).toBe(1));
    expect(called).toEqual(packPrintApiPaths('board'));
    // The management pack's two paths are NOT in the board list — a change
    // that put them back would authorise fetches this page never makes.
    expect(packPrintApiPaths('board')).not.toContain('/api/accounting/reports-pack');
  });

  it('renders the twelve pages it fetched, and becomes print-ready', async () => {
    const document = serialisePackPagesDocument(buildBoardPackPages(demoInput));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: true, data: document }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const { container } = render(
      <PackPagesPrintPage packType="board" from="2026-03-01" to="2026-08-31" />,
    );

    await waitFor(() => expect(container.querySelectorAll('.pack-page').length).toBe(12));
    await waitFor(
      () => expect(container.querySelector('[data-print-ready="true"]')).not.toBeNull(),
      { timeout: 3000 },
    );
  });

  /**
   * The failure this whole workstream exists to prevent: markup that did not
   * come out of `renderChartSvg` reaching a `dangerouslySetInnerHTML` sink on
   * a document a director forwards to a bank. It must NEVER become
   * print-ready — `usePrintReady` has no timeout, so the render fails loudly
   * instead of photographing the page.
   */
  it('never becomes print-ready when a chart on the wire fails the guards', async () => {
    const document = JSON.parse(JSON.stringify(
      serialisePackPagesDocument(buildBoardPackPages(demoInput)),
    )) as { pages: Array<{ blocks: Array<{ kind: string; chart?: { svg: string } }> }> };
    const chart = document.pages.flatMap((p) => p.blocks).find((b) => b.kind === 'chart');
    chart!.chart!.svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/p.png"/></svg>';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: true, data: document }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const { container, findByText } = render(
      <PackPagesPrintPage packType="board" from="2026-03-01" to="2026-08-31" />,
    );

    await findByText(/could not be built/);
    expect(container.querySelector('[data-print-ready="true"]')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.example');
  });
});
