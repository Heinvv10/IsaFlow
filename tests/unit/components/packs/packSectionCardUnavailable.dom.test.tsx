/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * THE INTERACTIVE CARD PRINTS A REASON, NOT A STAND-IN NUMBER. When the cash
 * flow statement could not be read the service still returns numbers — net
 * profit under "Operating CF" — and marks the lines unavailable beside them.
 *
 * Every section here is built by `buildReportPack`. The first version of this
 * test hand-wrote the `unavailable` map with short keys the service never
 * writes, so it passed against a card that matched nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ log: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { SectionCard } from '@/components/accounting/packs/PackSectionCard';
import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';

const BASE: ReportPackInput = {
  companyName: 'Demo', period: '2026-03-01 to 2026-08-31',
  revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, netProfit: 480_123,
  totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 2_200_000,
  currentAssets: 1_900_000, currentLiabilities: 950_000,
  cash: 2_046_825, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
};
const FLOWS = { operatingCashFlow: 345_678, investingCashFlow: -98_765, financingCashFlow: 12_345 };

function sectionOf(input: ReportPackInput, type: 'cash_flow' | 'ratios') {
  return buildReportPack('management', input, '2026-03-01', '2026-08-31').sections.find((s) => s.type === type)!;
}

function open(section: ReturnType<typeof sectionOf>) {
  const view = render(<SectionCard section={section} />);
  fireEvent.click(screen.getByRole('button'));
  return view;
}
const valueOf = (label: string) => screen.getByText(label).nextElementSibling!.textContent!;
const digits = (s: string) => s.replace(/\D/g, '');

beforeEach(() => { warn.mockClear(); cleanup(); });

describe('SectionCard cash flow, from the real service', () => {
  it('prints reasons, and no stand-in figure, when no cash flow statement was read', () => {
    open(sectionOf(BASE, 'cash_flow'));
    for (const label of ['Operating CF', 'Investing CF', 'Financing CF', 'Net Cash Flow', 'Opening Cash']) {
      expect(valueOf(label), label).not.toMatch(/\d/);
      expect(valueOf(label), label).not.toBe('');
    }
    // Net profit, which the service puts in operatingCashFlow as a stand-in.
    expect(document.body.textContent).not.toContain('480');
    expect(digits(valueOf('Closing Cash'))).toBe('2046825');
  });

  it('prints only the lines a partial read leaves unstated', () => {
    open(sectionOf({ ...BASE, operatingCashFlow: 345_678 }, 'cash_flow'));
    expect(digits(valueOf('Operating CF'))).toBe('345678');
    expect(valueOf('Investing CF')).not.toMatch(/\d/);
    expect(valueOf('Net Cash Flow')).not.toMatch(/\d/);
    expect(digits(valueOf('Closing Cash'))).toBe('2046825');
  });

  it('prints all six figures when all three flows were read', () => {
    open(sectionOf({ ...BASE, ...FLOWS }, 'cash_flow'));
    expect(digits(valueOf('Operating CF'))).toBe('345678');
    expect(digits(valueOf('Investing CF'))).toBe('98765');
    expect(digits(valueOf('Financing CF'))).toBe('12345');
    expect(digits(valueOf('Net Cash Flow'))).toBe(String(345_678 - 98_765 + 12_345));
    expect(digits(valueOf('Opening Cash'))).toBe(String(2_046_825 - (345_678 - 98_765 + 12_345)));
    expect(digits(valueOf('Closing Cash'))).toBe('2046825');
  });
});

describe('SectionCard ratios, from the real service', () => {
  it('prints the stated reason for a ratio the service could not compute, never [object Object]', () => {
    open(sectionOf(BASE, 'ratios'));
    expect(document.body.textContent).not.toContain('[object Object]');
    expect(document.body.textContent).not.toContain('null');
  });
});

describe('SectionCard on a payload that predates the unavailable fields', () => {
  it('shows a cash flow section as stored, and warns exactly once across two renders', () => {
    const { unavailable: _omitted, ...old } = sectionOf({ ...BASE, ...FLOWS }, 'cash_flow').data;
    const section = { type: 'cash_flow', title: 'Cash flow', data: old };
    open(section);
    expect(digits(valueOf('Operating CF'))).toBe('345678');
    cleanup();
    open(section);
    expect(digits(valueOf('Closing Cash'))).toBe('2046825');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('shows a ratios section as stored', () => {
    const { notMeaningful: _omitted, ...old } = sectionOf(BASE, 'ratios').data;
    open({ type: 'ratios', title: 'Ratios', data: old });
    expect(screen.getAllByText(/Ratio/).length).toBeGreaterThan(0);
  });

  it('still throws on a present-but-malformed field', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = { ...sectionOf({ ...BASE, ...FLOWS }, 'cash_flow').data, unavailable: [] };
    expect(() => open({ type: 'cash_flow', title: 'Cash flow', data })).toThrow(/unavailable/);
    quiet.mockRestore();
  });
});
