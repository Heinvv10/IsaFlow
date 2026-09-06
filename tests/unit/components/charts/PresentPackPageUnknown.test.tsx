/**
 * An unknown `pack` route param (or a missing from/to range) previously left
 * the page spinning forever — the load effect's guard clause returned
 * without ever setting `slides` or `error`. This pins the visible "Unknown
 * pack" error state instead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const push = vi.fn();
let query: Record<string, string> = {};

vi.mock('next/router', () => ({
  useRouter: () => ({ query, isReady: true, push }),
}));

const apiJson = vi.fn();
vi.mock('@/lib/apiFetch', () => ({ apiJson: (...args: unknown[]) => apiJson(...args) }));

import PresentPackPage from '@/../pages/accounting/reports/present/[pack]';

afterEach(() => {
  cleanup();
  query = {};
  apiJson.mockReset();
});

describe('the present pack page with an unrecognised pack type', () => {
  it('renders an explicit "Unknown pack" error instead of spinning forever', async () => {
    apiJson.mockRejectedValue(new Error('should not be called'));
    query = { pack: 'nonsense', from: '2026-01-01', to: '2026-01-31' };
    render(<PresentPackPage />);
    expect(await screen.findByText(/Unknown pack/i)).toBeInTheDocument();
  });

  it('renders the same error state when the pack is valid but the date range is missing', async () => {
    apiJson.mockRejectedValue(new Error('should not be called'));
    query = { pack: 'board' };
    render(<PresentPackPage />);
    expect(await screen.findByText(/Unknown pack/i)).toBeInTheDocument();
  });
});

describe('navigating from an unknown pack to a valid one', () => {
  it('clears the "Unknown pack" banner once the params become valid (residual 2)', async () => {
    apiJson.mockRejectedValue(new Error('should not be called'));
    query = { pack: 'nonsense' };
    const { rerender } = render(<PresentPackPage />);
    expect(await screen.findByText(/Unknown pack/i)).toBeInTheDocument();

    // Client-side navigation to a valid pack + range changes `query` and
    // re-renders with the SAME mounted component — the bug was that `error`
    // never got cleared on this path, so the stale banner stayed on screen
    // even once the pack fetch below resolves.
    apiJson.mockImplementation(async (url: string) => {
      if (url.includes('reports-pack')) {
        return { pack: { type: 'board', companyName: 'Acme', period: '2026', generatedAt: '2026-01-01', sections: [] } };
      }
      if (url.includes('reports-budget-comparator')) return { lines: [], budgetedCount: 0 };
      if (url.includes('reports-account-trends')) return { months: [], byAccountCode: {}, unavailable: {} };
      return {};
    });
    query = { pack: 'board', from: '2026-01-01', to: '2026-01-31' };
    rerender(<PresentPackPage />);

    expect(await screen.findByText('Acme — Board Pack')).toBeInTheDocument();
    expect(screen.queryByText(/Unknown pack/i)).not.toBeInTheDocument();
  });
});
