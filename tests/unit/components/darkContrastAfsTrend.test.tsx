/**
 * Dark theme, wave-2 re-score: the AFS list's date (3.75:1) and Trend Analysis's negative growth rate (3.74:1). The
 * tests render the real element, take the colour its classes give in dark mode from Tailwind's palette, take the surface
 * from styles/globals.css (#0f172a and #334155, what the browser measured) and compute WCAG contrast. Happy-dom has no
 * stylesheet, so this is the class the browser would apply, not a measured pixel; the sweep measures the real page.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import colors from 'tailwindcss/colors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/afs/AfsCreateModal', () => ({ AfsCreateModal: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { formatDisplayDate } from '@/utils/dateFormat';
import AfsIndexPage from '../../../pages/accounting/afs/index';
import TrendAnalysisPage from '../../../pages/accounting/reports/trend-analysis';

useApiJsonOverMock();
afterEach(cleanup);

const palette = colors as unknown as Record<string, Record<string, string>>;
const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string): number => {
  const [r, g, b] = channels(hex).map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** The text colour an element has in dark mode: its `dark:text-*` class, else its plain `text-*` class. */
function darkInk(el: Element): string {
  const stops = [...el.className.matchAll(/(?<![\w:-])(dark:)?text-([a-z]+)-(\d{2,3})(?![\w/-])/g)];
  const stop = stops.find((m) => m[1]) ?? stops[0];
  if (!stop) throw new Error(`no text colour on <${el.tagName}> "${el.className}"`);
  return palette[stop[2]!]![stop[3]!]!;
}

/** A dark-theme `--ff-*` surface from globals.css: the last definition, since the dark block follows the light one. */
function darkSurface(token: string): string {
  const css = readFileSync(join(process.cwd(), 'styles/globals.css'), 'utf8');
  const hex = [...css.matchAll(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].at(-1)?.[1];
  if (!hex) throw new Error(`no ${token} in globals.css`);
  return hex;
}

describe('dark-theme text meets AA (4.5:1)', () => {
  it('the AFS list date on the page background', async () => {
    const updatedAt = '2026-04-16T10:00:00Z';
    vi.mocked(apiFetch).mockImplementation(async () => ok({ documents: [{ id: 'd1', documentType: 'afs', fiscalYear: 2026, reportingFramework: 'ifrs_smes', version: 1, status: 'draft', updatedAt }] }));
    render(<AfsIndexPage />);
    const date = await screen.findByText(formatDisplayDate(updatedAt));
    expect(contrast(darkInk(date), darkSurface('--ff-bg-primary'))).toBeGreaterThanOrEqual(4.5);
  });

  it('a negative month-over-month rate on its tile', async () => {
    const dataPoints = [{ period: 'Jan', value: 100 }, { period: 'Feb', value: 95 }];
    vi.mocked(apiFetch).mockImplementation(async () => ok({ analysis: { dataPoints, growthRates: [-4.7], movingAverage3: [null, null], anomalies: [], cmgr: -4.7 } }));
    render(<TrendAnalysisPage />);
    const rate = await screen.findByText('-4.7%', { selector: 'p.text-lg' });
    const tile = rate.parentElement!;
    expect(tile.className).toContain('bg-[var(--ff-bg-tertiary)]');
    expect(contrast(darkInk(rate), darkSurface('--ff-bg-tertiary'))).toBeGreaterThanOrEqual(4.5);
  });
});
