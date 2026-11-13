/**
 * The tour opens only when the server says the user has not completed it. A failed preference read (a 5xx, a
 * dropped connection) is unknown, not "never seen": it must not put the full-screen overlay over a returning user's
 * page. That overlay covered the top nav and failed q-top-nav-hover in golden paths (#1270).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const { apiFetch, warn } = vi.hoisted(() => ({ apiFetch: vi.fn(), warn: vi.fn() }));

vi.mock('@/lib/apiFetch', () => ({
  apiFetch,
  assertOk: async (res: Response, fallback: string) => { if (!res.ok) throw new Error(fallback); },
  apiErrorMessage: (_e: unknown, m: string) => m,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));

import { AccountingTour } from '@/components/onboarding/AccountingTour';
import { TOUR_STEPS } from '@/components/onboarding/tourConfig';

afterEach(() => { cleanup(); apiFetch.mockReset(); warn.mockReset(); localStorage.clear(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const firstTitle = TOUR_STEPS[0]!.title;

describe('AccountingTour preference read', () => {
  it('opens for a user with no completed-tour preference', async () => {
    apiFetch.mockResolvedValue(json({ data: {} }));
    render(<AccountingTour />);
    expect(await screen.findByText(firstTitle)).toBeTruthy();
  });

  it('stays closed when the preference says completed', async () => {
    apiFetch.mockResolvedValue(json({ data: { onboarding_tour_completed: 'true' } }));
    render(<AccountingTour />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/auth/preferences'));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(firstTitle)).toBeNull();
  });

  it.each([
    ['a 500', () => Promise.resolve(json({ success: false }, 500))],
    ['a dropped connection', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('stays closed when the read fails with %s', async (_label, respond) => {
    apiFetch.mockImplementation(respond);
    render(<AccountingTour />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith('Failed to load tour preference', expect.anything(), 'AccountingTour'));
    expect(screen.queryByText(firstTitle)).toBeNull();
    expect(document.querySelector('.fixed.inset-0')).toBeNull();
    // Nothing is recorded, so a later visit asks the server again.
    expect(localStorage.getItem('isaflow_tour_completed')).toBeNull();
  });
});
