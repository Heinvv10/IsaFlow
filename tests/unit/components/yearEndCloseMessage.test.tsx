/**
 * The year-end screen must say a close FAILED when the route refuses it.
 *
 * It showed "Year X closed. Closing journal created." on any 2xx and, on a
 * non-2xx, read `json.message` — which the apiResponse envelope never sets, so
 * every refusal collapsed to a generic line. Rendered against the real
 * envelope shape the route sends, not a hand-shaped body.
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
    serve(200, { success: true, data: { closingEntry: { id: 'j' }, netIncome: 0, message: 'Year 2026 closed.' } });
    await processYear();
    await waitFor(() => expect(screen.getByText(/Year 2026 closed/)).toBeInTheDocument());
  });
});
