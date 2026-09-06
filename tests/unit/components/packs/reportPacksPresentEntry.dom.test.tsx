/**
 * The packs page is the third way into presentation mode, and the only one
 * that can name a pack other than `management`.
 *
 * The deck route takes all three types; the two statement pages have no pack
 * to name and present the management deck. Here the reader is looking AT a
 * pack over a period, and both must reach the deck — a Present control that
 * always said `management` would show a board reader a different document
 * from the one on their screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'viewer' }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, query: {}, pathname: '/accounting/reports/report-packs' }),
}));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const apiFetchMock = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  assertOk: vi.fn(() => Promise.resolve({})),
}));

import ReportPacksPage from '../../../../pages/accounting/reports/report-packs';

const PACK = {
  type: 'board',
  companyName: 'Brightsphere',
  period: '2026-01-01 to 2026-09-06',
  generatedAt: '2026-09-06T00:00:00.000Z',
  sections: [{ type: 'commentary', title: 'Commentary', data: { summary: 'All good.' } }],
};

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async () => ({
    status: 200,
    headers: { get: () => null },
    json: async () => ({ success: true, data: { pack: PACK, unclassifiedAccounts: null } }),
  }));
});

afterEach(() => { cleanup(); });

/** The href, once the first pack load has settled. */
async function presentHref(): Promise<string> {
  const link = await screen.findByRole('link', { name: /Present/ });
  return link.getAttribute('href') ?? '';
}

describe('Report Packs screen — the way into presentation mode', () => {
  it('presents the pack on screen, over the period on screen', async () => {
    render(<ReportPacksPage />);
    const href = await presentHref();
    const url = new URL(href, 'https://x');

    // Board is the page's initial selection, so the deck must not be handed
    // the management default the statement pages use.
    expect(url.pathname).toBe('/accounting/reports/present/board');
    expect(url.searchParams.get('from')).toBeTruthy();
    expect(url.searchParams.get('to')).toBeTruthy();
  });

  it('follows the pack selector', async () => {
    render(<ReportPacksPage />);
    await presentHref();

    fireEvent.click(screen.getByText('Monthly Pack'));

    await waitFor(async () => {
      expect(new URL(await presentHref(), 'https://x').pathname)
        .toBe('/accounting/reports/present/monthly');
    });
  });

  it('hands the deck the same range the download buttons use', async () => {
    render(<ReportPacksPage />);
    const url = new URL(await presentHref(), 'https://x');

    const packCall = apiFetchMock.mock.calls.map(c => String(c[0]))
      .find(u => u.includes('/api/accounting/reports-pack?'))!;
    const packQs = new URL(packCall, 'https://x').searchParams;

    expect(url.searchParams.get('from')).toBe(packQs.get('from'));
    expect(url.searchParams.get('to')).toBe(packQs.get('to'));
  });
});
