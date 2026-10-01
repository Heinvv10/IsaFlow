/**
 * Runs under vitest.components.config.ts (happy-dom): `bun run test:components`.
 *
 * THE INTERACTIVE CARD PRINTS A REASON, NOT A STAND-IN NUMBER. When the cash
 * flow statement could not be read the service still returns numbers — net
 * profit under "Operating CF" — and marks the lines unavailable beside them.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { SectionCard } from '@/components/accounting/packs/PackSectionCard';

const FULL = {
  operatingCashFlow: 111_000, investingCashFlow: -22_000, financingCashFlow: 33_000,
  netCashFlow: 122_000, openingCash: 400_000, closingCash: 522_000, unavailable: {},
};

function open(section: { type: string; title: string; data: Record<string, unknown> }) {
  const view = render(<SectionCard section={section} />);
  fireEvent.click(screen.getByRole('button'));
  return view;
}
const valueOf = (label: string) => screen.getByText(label).nextElementSibling!.textContent;

const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ log: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

describe('SectionCard cash flow', () => {
  it('prints the reason, and no figure, for each line the section marks unavailable', () => {
    open({ type: 'cash_flow', title: 'Cash flow', data: {
      ...FULL, operatingCashFlow: 999_999, netCashFlow: 888_888, openingCash: 777_777,
      unavailable: {
        operating: 'Operating cash flow could not be read.',
        net: 'Net cash flow needs all three activities.',
        opening: 'Opening cash needs all three activities.',
      },
    } });
    expect(valueOf('Operating CF')).toBe('Operating cash flow could not be read.');
    expect(valueOf('Net Cash Flow')).toBe('Net cash flow needs all three activities.');
    expect(valueOf('Opening Cash')).toBe('Opening cash needs all three activities.');
    expect(document.body.textContent).not.toMatch(/999|888|777/);
    expect(valueOf('Closing Cash')).toMatch(/522/);
    expect(valueOf('Investing CF')).toMatch(/22/);
  });

  it('prints all six figures when nothing is unavailable', () => {
    open({ type: 'cash_flow', title: 'Cash flow', data: FULL });
    for (const [label, digits] of [
      ['Operating CF', '111'], ['Investing CF', '22'], ['Financing CF', '33'],
      ['Net Cash Flow', '122'], ['Opening Cash', '400'], ['Closing Cash', '522'],
    ] as const) expect(valueOf(label), label).toMatch(new RegExp(digits));
  });
});

describe('SectionCard ratios', () => {
  it('prints the stated reason for a ratio the service could not compute', () => {
    open({ type: 'ratios', title: 'Ratios', data: {
      currentRatio: 1.5, freeCashFlow: 0,
      notMeaningful: { freeCashFlow: 'No cash flow statement to read.' },
    } });
    expect(valueOf('Current Ratio')).toBe('1.50');
    expect(valueOf('Free Cash Flow')).toBe('No cash flow statement to read.');
    expect(document.body.textContent).not.toContain('[object Object]');
  });
});

describe('SectionCard on a payload that predates the unavailable fields', () => {
  it('shows a cash flow section\'s figures as stored, and warns once', () => {
    const { unavailable: _omitted, ...old } = FULL;
    open({ type: 'cash_flow', title: 'Cash flow', data: old });
    expect(valueOf('Operating CF')).toMatch(/111/);
    expect(valueOf('Closing Cash')).toMatch(/522/);
    expect(warn).toHaveBeenCalled();
  });

  it('shows a ratios section\'s figures as stored', () => {
    open({ type: 'ratios', title: 'Ratios', data: { currentRatio: 1.5 } });
    expect(valueOf('Current Ratio')).toBe('1.50');
  });

  it('still throws on a present-but-malformed field', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => open({ type: 'cash_flow', title: 'Cash flow', data: { ...FULL, unavailable: [] } })).toThrow(/unavailable/);
    quiet.mockRestore();
  });
});
