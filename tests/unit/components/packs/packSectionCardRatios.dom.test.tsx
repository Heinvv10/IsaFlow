/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * THE ON-SCREEN RATIOS ARE NAMED AND WRITTEN LIKE EVERY OTHER SURFACE'S. The
 * card split the engine key on its capitals and `toFixed(2)`'d every value, so
 * a rand amount read "Ebitda -1883824.19" beside a margin that read "25.43" —
 * no unit on either. Sections here come from `buildReportPack`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { SectionCard } from '@/components/accounting/packs/PackSectionCard';
import { ratioLines } from '@/modules/accounting/services/reports/ratioPresentation';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';

const INPUT: ReportPackInput = {
  companyName: 'Demo', period: '2026-03-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_123,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
};
const ratios = (input: ReportPackInput) =>
  buildReportPack('management', input, '2026-03-01', '2026-08-31').sections.find((s) => s.type === 'ratios')!;

function open(section: { type: string; title: string; data: Record<string, unknown> }) {
  render(<SectionCard section={section} />);
  fireEvent.click(screen.getByRole('button'));
}
const valueOf = (label: string) => screen.getByText(label).nextElementSibling!.textContent!;

afterEach(cleanup);

describe('SectionCard ratios', () => {
  it('names a ratio by its label, not by its key split on capitals', () => {
    open(ratios(INPUT));
    expect(screen.getByText('Gross Profit Margin')).toBeTruthy();
    expect(screen.queryByText('Gross Profit Margin ')).toBeNull();
    expect(screen.queryByText(/^Ebitda/)).toBeNull();
  });

  it('writes a margin as a percentage', () => {
    open(ratios(INPUT));
    expect(valueOf('Gross Profit Margin')).toMatch(/^\+?\(?[\d  ]+\.\d%\)?$/);
  });

  it('writes a rand amount as money, grouped, never as a bare run of digits', () => {
    open(ratios(INPUT));
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d{7,}/);
  });

  it('writes a ratio of no unit as two decimals', () => {
    open(ratios(INPUT));
    expect(valueOf('Current Ratio')).toMatch(/^\(?\d+\.\d\d\)?$/);
  });

  it('prints the service\'s own reason string for every ratio it could not compute', () => {
    const section = ratios({ ...INPUT, totalEquity: -500_000, revenue: -1 });
    const reasons = section.data.notMeaningful as Record<string, string>;
    const shown = ratioLines(section.data).slice(0, 12).filter((l) => reasons[l.key] !== undefined);
    // Anti-vacuity: this fixture must put at least two reasons on the card.
    expect(shown.length).toBeGreaterThanOrEqual(2);
    open(section);
    // The engine's own sentences (`ratioBasis.ts`), so the card cannot pass by
    // echoing a placeholder: a base that is not positive, an input the report
    // never read, an input read and nil, or a stated "Not stated: …".
    const ENGINE_REASON = /is not positive, so this ratio has no meaning\.$|is not captured in this report, so this ratio cannot be stated\.$|^No .+ recorded in the period, so this ratio cannot be stated\.$|^Not stated: |^Interest income is at least interest expense|^Equity is negative — liabilities exceed assets, so this ratio inverts/;
    for (const line of shown) {
      expect(valueOf(line.label), line.label).toBe(reasons[line.key]);
      expect(reasons[line.key], line.key).toMatch(ENGINE_REASON);
    }
    expect(document.body.textContent).not.toContain('null');
    expect(document.body.textContent).not.toContain('[object Object]');
  });
});
