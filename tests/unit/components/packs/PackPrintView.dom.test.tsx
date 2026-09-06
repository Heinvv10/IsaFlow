/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * The printed pack as the renderer photographs it. The readiness gate is the
 * assertion that matters most: renderPagePdf waits for
 * [data-print-ready="true"] and nothing else, so a view that announced itself
 * ready before its document arrived would produce a PDF of an empty page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

vi.mock('@/components/charts/EChartClient', () => ({ EChartClient: () => <div data-testid="echart" /> }));

import { PackPrintView } from '@/components/accounting/packs/PackPrintView';

afterEach(() => {
  cleanup();
  document.documentElement.className = '';
  window.localStorage.clear();
});

const doc: PackDocument = {
  packType: 'management',
  companyName: 'ISAFlow Demo',
  period: '2026-01-01 to 2026-09-05',
  generatedAt: '2026-09-06T08:00:00.000Z',
  sections: [
    { type: 'income_statement', title: 'Statement of Comprehensive Income', landscape: false,
      blocks: [{ kind: 'statement', rows: [{ id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: 1275632.74 }] }] },
    { type: 'balance_sheet', title: 'Statement of Financial Position', landscape: false,
      blocks: [{ kind: 'text', text: 'nothing to see' }] },
  ],
};

describe('PackPrintView', () => {
  it('opens with a cover naming the company, the pack and the period', () => {
    render(<PackPrintView document={doc} />);
    expect(screen.getByText('ISAFlow Demo')).toBeTruthy();
    expect(screen.getByText('Management Pack')).toBeTruthy();
    expect(screen.getByText('2026-01-01 to 2026-09-05')).toBeTruthy();
  });

  it('lists every section in the table of contents, numbered and in order', () => {
    const { container } = render(<PackPrintView document={doc} />);
    const entries = [...container.querySelectorAll('[data-pack-toc] li')].map((li) => li.textContent);
    expect(entries).toEqual([
      '1. Statement of Comprehensive Income',
      '2. Statement of Financial Position',
    ]);
  });

  it('breaks the page after the cover and after the contents', () => {
    const { container } = render(<PackPrintView document={doc} />);
    expect(container.querySelector('[data-pack-cover]')).toBeTruthy();
    expect(container.querySelector('[data-pack-toc]')).toBeTruthy();
  });

  it('announces print-readiness once a chartless pack has rendered', async () => {
    const { container } = render(<PackPrintView document={doc} />);
    await waitFor(() => {
      expect(container.querySelector('[data-print-ready="true"]')).toBeTruthy();
    });
  });

  it('is NOT print-ready before its document arrives', () => {
    const { container } = render(<PackPrintView document={null} />);
    expect(container.querySelector('[data-print-ready="true"]')).toBeNull();
  });
});
