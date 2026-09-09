/**
 * The year-end page reports what the CLOSE said, not what it used to assume.
 *
 * A 200 from /api/accounting/year-end no longer means a closing journal was
 * written. A dormant year closes with no journal at all, and a re-run of an
 * already-closed year reports the journal an earlier close wrote. The page used
 * to announce "Closing journal created" for every 200, which for the re-run
 * tells the operator this run posted something it did not — the exact confusion
 * the already-closed lookup exists to prevent.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import YearEndPage from '@/../pages/accounting/year-end';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const YEAR = {
  year_label: '2025', start_date: '2025-01-01', end_date: '2025-12-31', status: 'open',
  periods_open: 0, periods_closed: 12, total_revenue: 0, total_expenses: 0, net_income: 0,
};

/** GET returns one closeable year; POST returns the given close result. */
function mockApi(closeBody: Record<string, unknown>, status = 200) {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    (init?.method === 'POST'
      ? new Response(JSON.stringify({ data: closeBody }), { status })
      : new Response(JSON.stringify({ data: { years: [YEAR] } }), { status: 200 })));
}

async function clickClose() {
  render(<YearEndPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Process Year-End/ }));
}

describe('year-end page success message', () => {
  it('renders the DORMANT year sentence instead of claiming a journal was created', async () => {
    mockApi({
      closingEntry: null, periodsLocked: 12, alreadyClosed: false, netIncome: 0,
      message: 'Year 2025 closed. No posted profit or loss in the year, so no closing journal was needed.',
    });
    await clickClose();
    expect(await screen.findByText(/no closing journal was needed/i)).toBeTruthy();
    expect(screen.queryByText(/Closing journal created/i)).toBeNull();
  });

  it('renders the ALREADY-CLOSED sentence, naming the journal an earlier close wrote', async () => {
    mockApi({
      closingEntry: { id: 'je-1', entry_number: 'YE-2025' }, periodsLocked: 12,
      alreadyClosed: true, netIncome: 0,
      message: 'Year 2025 was already closed. Its closing journal YE-2025 is unchanged and nothing was posted.',
    });
    await clickClose();
    expect(await screen.findByText(/was already closed.*nothing was posted/i)).toBeTruthy();
    expect(screen.queryByText(/Closing journal created/i)).toBeNull();
  });

  it('renders the ordinary close sentence, with the amount the service reported', async () => {
    mockApi({
      closingEntry: { id: 'je-2', entry_number: 'YE-2025' }, periodsLocked: 12,
      alreadyClosed: false, netIncome: 1300,
      message: 'Year 2025 closed. Net income R1300.00 transferred to Retained Earnings.',
    });
    await clickClose();
    expect(await screen.findByText(/Net income R1300\.00 transferred to Retained Earnings/)).toBeTruthy();
  });

  it('still shows the API message on a refusal', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
      (init?.method === 'POST'
        ? new Response(JSON.stringify({ message: 'This year already has a closing journal (YE-2025) and it is reversed, not posted.' }), { status: 409 })
        : new Response(JSON.stringify({ data: { years: [YEAR] } }), { status: 200 })));
    await clickClose();
    expect(await screen.findByText(/reversed, not posted/i)).toBeTruthy();
  });
});
