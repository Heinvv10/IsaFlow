/**
 * What the year-end screen SAYS after a close, for every outcome the route has.
 *
 * Two defects, one banner:
 *
 * 1. A refusal has to read as a failure. The page showed "Year X closed.
 *    Closing journal created." on any 2xx and, on a non-2xx, read
 *    `json.message` — which the apiResponse envelope never sets, so every
 *    refusal collapsed to a generic line. The refusal cases below are rendered
 *    against the REAL envelope shape the route sends, not a hand-shaped body.
 *
 * 2. A 200 no longer means a closing journal was written. A dormant year closes
 *    with no journal at all, and a re-run of an already-closed year reports the
 *    journal an earlier close wrote. Announcing "Closing journal created" for
 *    either tells the operator this run posted something it did not — the exact
 *    confusion the already-closed lookup exists to prevent. So the page renders
 *    the SERVICE's sentence.
 *
 * The transport is the real `apiFetch`/`assertOk` over a stubbed global fetch,
 * not a mock of `@/lib/apiFetch`: `assertOk` is the half that digs the reason
 * out of `error.message`, and mocking the module past it would test nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
import YearEndPage from '../../../pages/accounting/year-end/index';

const year = { year_label: '2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open', periods_open: 0,
  periods_closed: 12, total_revenue: 0, total_expenses: 0, net_income: 0 };
const REASON = "Fiscal year 2026's periods run 2026-01-01 to 2026-12-31, but this company's financial year starts in March. Nothing was closed.";

function serve(closeStatus: number, closeBody: unknown) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.method === 'POST' ? closeBody : { success: true, data: { years: [year] } };
    return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? closeStatus : 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
/** A successful close, as the route's envelope carries it. */
function serveClose(data: Record<string, unknown>) {
  return serve(200, { success: true, data });
}
async function processYear() {
  render(<YearEndPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Process Year-End/i }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('year-end close message', () => {
  it('a refused close shows the route\'s reason and never the success line', async () => {
    serve(409, { success: false, error: { code: 'CONFLICT', message: REASON } });
    await processYear();
    await waitFor(() => expect(screen.getByText(REASON)).toBeInTheDocument());
    expect(screen.queryByText(/closed\. Closing journal created/i)).not.toBeInTheDocument();
  });

  it('a 500 shows a failure, not the success line', async () => {
    serve(500, { success: false, error: { code: 'DATABASE_ERROR', message: 'Failed to process year-end' } });
    await processYear();
    await waitFor(() => expect(screen.getByText('Failed to process year-end')).toBeInTheDocument());
    expect(screen.queryByText(/closed\. Closing journal created/i)).not.toBeInTheDocument();
  });

  it('a completed close still says so', async () => {
    serveClose({ closingEntry: { id: 'j' }, netIncome: 0, message: 'Year 2026 closed.' });
    await processYear();
    await waitFor(() => expect(screen.getByText(/Year 2026 closed/)).toBeInTheDocument());
  });

  it('renders the ordinary close sentence, with the amount the service reported', async () => {
    serveClose({
      closingEntry: { id: 'je-2', entry_number: 'YE-2026' }, periodsLockedInYear: 12,
      alreadyClosed: false, netIncome: 1300, unclosedNetIncome: 0,
      message: 'Year 2026 closed. Net income R1300.00 transferred to Retained Earnings.',
    });
    await processYear();
    await waitFor(() => expect(
      screen.getByText(/Net income R1300\.00 transferred to Retained Earnings/)).toBeInTheDocument());
  });

  it('renders the DORMANT year sentence instead of claiming a journal was created', async () => {
    serveClose({
      closingEntry: null, periodsLockedInYear: 12, alreadyClosed: false, netIncome: 0, unclosedNetIncome: 0,
      message: 'Year 2026 closed. No posted profit or loss in the year, so no closing journal was needed.',
    });
    await processYear();
    await waitFor(() => expect(screen.getByText(/no closing journal was needed/i)).toBeInTheDocument());
    expect(screen.queryByText(/Closing journal created/i)).not.toBeInTheDocument();
  });

  it('renders the ALREADY-CLOSED sentence, naming the journal an earlier close wrote', async () => {
    serveClose({
      closingEntry: { id: 'je-1', entry_number: 'YE-2026' }, periodsLockedInYear: 12,
      alreadyClosed: true, netIncome: 0, unclosedNetIncome: 0,
      message: 'Year 2026 was already closed. Its closing journal YE-2026 is unchanged and nothing was posted.',
    });
    await processYear();
    await waitFor(() => expect(
      screen.getByText(/was already closed.*nothing was posted/i)).toBeInTheDocument());
    expect(screen.queryByText(/Closing journal created/i)).not.toBeInTheDocument();
  });

  it('flags an already-closed year that gained P&L as a WARNING, not a green tick', async () => {
    // The residual is P&L posted into the year after its close: in no closing
    // journal, in no equity account, and unreachable by any re-run because the
    // entry number is taken. A green tick beside that sentence reads as
    // "nothing to do here", which is the opposite of what it says.
    serveClose({
      closingEntry: { id: 'je-1', entry_number: 'YE-2026' }, periodsLockedInYear: 12,
      alreadyClosed: true, netIncome: 150, unclosedNetIncome: 150,
      message: 'Year 2026 was already closed. Its closing journal YE-2026 is unchanged and '
        + 'nothing was posted. WARNING: R150.00 of profit or loss has been posted into this '
        + 'year SINCE it was closed, and it is NOT in YE-2026 and NOT in retained earnings.',
    });
    await processYear();
    const banner = await waitFor(() => screen.getByText(/NOT in retained earnings/));
    expect(banner.className).toMatch(/text-red-400/);
    expect(banner.className).not.toMatch(/text-teal-400/);
  });
});
