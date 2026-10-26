/**
 * R-120 review round 3: the two pages on the remedy path.
 *  - Approvals listed only 'submitted' entries, so an APPROVED entry that WIP
 *    billing refuses could not be selected for the write-off its refusal names.
 *  - Time tracking read `json.message` on failure; the envelope is
 *    `{ error: { message } }`, so the practice-entry refusal showed as "Failed".
 * Only apiFetch is mocked; assertOk and apiErrorMessage are the real ones.
 */
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ApprovalsPage from '../../../pages/accounting/practice/approvals';
import TimeTrackingPage from '../../../pages/accounting/time-tracking';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(),
}));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const refusal = (message: string) =>
  Response.json({ success: false, error: { code: 'BAD_REQUEST', message } }, { status: 400 });

it('approvals: the Approved status lists approved entries and they can be written off', async () => {
  const urls: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    urls.push(String(url));
    if (init?.method === 'POST') return refusal('R120 write-off refusal text');
    if (String(url).startsWith('/api/accounting/practice/time-entries?')) {
      return Response.json({ success: true, data: { entries: [{
        id: 'te-1', userId: 'u-1', practiceClientId: 'pc-1', entryDate: '2026-01-05', taskDescription: 'Approved work',
        hours: 2, appliedRate: 100, lineTotal: 5000, status: 'approved',
      }], total: 1 } });
    }
    return Response.json({ success: true, data: [] });
  });
  render(<ApprovalsPage />);
  fireEvent.change(await screen.findByLabelText('Status'), { target: { value: 'approved' } });
  await waitFor(() => expect(urls.some((u) => u.includes('status=approved'))).toBe(true));
  fireEvent.click(await screen.findByText('Approved work'));
  expect(screen.getByRole('button', { name: /approve selected/i })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /write off selected/i }));
  fireEvent.change(screen.getByPlaceholderText(/Duplicate work/), { target: { value: 'line disagrees with hours × rate' } });
  fireEvent.click(screen.getByRole('button', { name: /confirm write-off/i }));
  expect(await screen.findByText('R120 write-off refusal text')).toBeInTheDocument();
});

it('time tracking: a refused edit shows the server’s reason, not "Failed"', async () => {
  const REFUSAL = 'This is a practice time entry: change its hours or rate on the practice timesheet';
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'PUT') return refusal(REFUSAL);
    if (String(url).startsWith('/api/accounting/time-entries')) {
      return Response.json({ success: true, data: { entries: [{
        id: 'te-1', projectName: null, taskDescription: 'Practice work', entryDate: '2026-01-05',
        hours: 4, rate: 250, amount: 1000, billable: true, invoiced: false, status: 'draft', customerId: null, notes: null,
      }], total: 1 } });
    }
    return Response.json({ success: true, data: [] });
  });
  render(<TimeTrackingPage />);
  await screen.findByText('Practice work');
  fireEvent.click(screen.getByTitle('Edit'));
  // Submit the form itself: happy-dom does not turn a submit-button click into one.
  fireEvent.submit((await screen.findByRole('button', { name: /update/i })).closest('form')!);
  expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
});
