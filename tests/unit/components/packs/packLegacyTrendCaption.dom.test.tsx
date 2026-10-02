/**
 * The management pack's trend page prints the caption that says where its
 * chart starts and which month is part — under the chart, not only in the
 * function that writes it. Runs under vitest.components.config.ts.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PackDocumentSection } from '@/modules/accounting/services/packs/packDocument';
import { liveDemoTrend } from '../../services/packs/fixtures/liveDemoBoardPack';

vi.mock('@/components/charts/EChartClient', () => ({
  EChartClient: () => <div data-testid="echart" />,
}));

import { PackSectionView } from '@/components/accounting/packs/PackSectionView';

afterEach(cleanup);

describe('the management pack trend page', () => {
  it('prints the coverage caption under the chart', () => {
    const revenue = [0, 0, 0, 0, 0, 0, 0, 0, 0, 36_800, 35_150, 29_730];
    const section: PackDocumentSection = {
      type: 'trend',
      title: '12-Month Trend',
      landscape: true,
      blocks: [{ kind: 'trend', points: liveDemoTrend.map((p, i) => ({ ...p, revenue: revenue[i]! })) }],
    };
    render(<PackSectionView section={section} />);
    expect(screen.getByText(/^Revenue by month, Jul 2026 to Sep 2026; none is posted before Jul 2026\. Sep 2026 is a part month/)).toBeTruthy();
  });
});
