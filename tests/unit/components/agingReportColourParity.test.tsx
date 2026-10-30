/**
 * The AR age analysis colours its bucket figures with the same light/dark class pairs as the AP page,
 * whose tiles pass axe colour-contrast in both themes (browser review of PR #915). The AR page had bare
 * red-400 / red-600 / yellow-400 / orange-400 / teal-400, which measured 3.0-4.07 on the tinted tiles.
 * happy-dom computes no contrast, so this pins the AR classes to the ones measured on AP.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import ARAgingPage from '../../../pages/accounting/reports/ar-aging';
import APAgingPage from '../../../pages/accounting/reports/ap-aging';

useApiJsonOverMock();
afterEach(cleanup);
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterAll(() => { vi.useRealTimers(); });

const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'];
const SUMMARY = BUCKETS.map((bucket, i) => ({ bucket, count: 1, total: 1000 + i }));
const AMOUNTS = ['R 1 000.00', 'R 1 001.00', 'R 1 002.00', 'R 1 003.00', 'R 1 004.00'];

async function amountClasses(Page: () => JSX.Element): Promise<string[]> {
  vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response(JSON.stringify({
    success: true, data: { rows: [], summary: SUMMARY, as_at_date: '2026-10-28' },
  }), { status: 200 }));
  render(<Page />);
  const out: string[] = [];
  for (const amount of AMOUNTS) out.push((await screen.findByText(amount)).className);
  return out;
}

/** The semantic colour tokens only (not teal-vs-blue, which is the page's accent). */
const tone = (cls: string) => cls.split(/\s+/).filter((c) => /(yellow|orange|red)-/.test(c)).sort().join(' ');

describe('AR bucket figures use the contrast-checked pairs', () => {
  it('1-30 to 90+ carry the same tokens as the AP page, and every colour has a dark: pair', async () => {
    const ar = await amountClasses(ARAgingPage as () => JSX.Element);
    cleanup();
    const ap = await amountClasses(APAgingPage as () => JSX.Element);
    for (let i = 1; i < 5; i++) expect(tone(ar[i]!), BUCKETS[i]).toBe(tone(ap[i]!));
    for (let i = 0; i < 5; i++) expect(ar[i], BUCKETS[i]).toMatch(/dark:text-/);
  });
});
