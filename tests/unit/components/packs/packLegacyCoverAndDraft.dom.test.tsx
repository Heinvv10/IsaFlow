/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * The legacy cover uses the footer's and the board cover's date forms, and a
 * draft pack's print view carries the watermark element.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@/components/charts/EChartClient', () => ({ EChartClient: () => <div /> }));

import { PackCover } from '@/components/accounting/packs/PackCover';
import { PackPrintView } from '@/components/accounting/packs/PackPrintView';
import { buildPackDocument, type PackDocument } from '@/modules/accounting/services/packs/packDocument';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';

afterEach(cleanup);

const doc = (over: Partial<PackDocument> = {}): PackDocument => ({
  packType: 'management', companyName: 'Demo', period: '2026-01-01 to 2026-09-07',
  generatedAt: '2026-09-07T22:30:00.000Z', sections: [], ...over,
});

describe('PackCover dates', () => {
  it('prints the period in words, as the footer and the board cover do', () => {
    const { container } = render(<PackCover document={doc()} />);
    expect(container.textContent).toContain('1 January 2026 to 7 September 2026');
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('prints the SAST day generated: 22:30 UTC is already the 8th', () => {
    const { container } = render(<PackCover document={doc()} />);
    expect(container.textContent).toContain('Generated 8 September 2026');
  });

  it('echoes a period that is not two ISO dates, unchanged', () => {
    const { container } = render(<PackCover document={doc({ period: 'FY2026' })} />);
    expect(container.textContent).toContain('FY2026');
  });
});

describe('PackPrintView draft mark', () => {
  const real = (draft: boolean) => buildPackDocument(
    buildReportPack('management', {
      companyName: 'Demo', period: 'p', revenue: 1, costOfSales: 0, operatingExpenses: 0, netProfit: 1,
      totalAssets: 1, totalLiabilities: 0, totalEquity: 1, currentAssets: 1, currentLiabilities: 0,
      cash: 1, accountsReceivable: 0, accountsPayable: 0, inventory: 0,
    }, '2026-01-01', '2026-08-31'), [], draft);

  it('renders the watermark and the draft attribute for a draft', () => {
    const { container } = render(<PackPrintView document={real(true)} />);
    expect(container.querySelector('[data-pack-watermark]')?.textContent).toBe('DRAFT');
    expect(container.querySelector('[data-pack-draft]')).not.toBeNull();
  });

  it('renders neither for a final pack', () => {
    const { container } = render(<PackPrintView document={real(false)} />);
    expect(container.querySelector('[data-pack-watermark]')).toBeNull();
    expect(container.querySelector('[data-pack-draft]')).toBeNull();
  });
});
