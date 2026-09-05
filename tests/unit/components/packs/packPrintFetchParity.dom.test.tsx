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
import { packPrintApiPaths } from '@/modules/accounting/services/packs/packSections';

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
