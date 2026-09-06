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

vi.mock('@/lib/apiFetch', () => ({
  apiJson: vi.fn().mockRejectedValue(new Error('should not be called')),
}));

import PresentPackPage from '@/../pages/accounting/reports/present/[pack]';

afterEach(() => {
  cleanup();
  query = {};
});

describe('the present pack page with an unrecognised pack type', () => {
  it('renders an explicit "Unknown pack" error instead of spinning forever', async () => {
    query = { pack: 'nonsense', from: '2026-01-01', to: '2026-01-31' };
    render(<PresentPackPage />);
    expect(await screen.findByText(/Unknown pack/i)).toBeInTheDocument();
  });

  it('renders the same error state when the pack is valid but the date range is missing', async () => {
    query = { pack: 'board' };
    render(<PresentPackPage />);
    expect(await screen.findByText(/Unknown pack/i)).toBeInTheDocument();
  });
});
