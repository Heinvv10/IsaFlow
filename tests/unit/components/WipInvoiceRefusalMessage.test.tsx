/**
 * R-120: the WIP board read a refused invoice's `json.error` as a string. The
 * envelope is `{ error: { code, message } }`, so the modal showed
 * "[object Object]" — and before the route was fixed, the message inside was
 * the masked "WIP invoice failed" anyway. Only apiFetch is mocked; assertOk
 * and apiErrorMessage are the real ones.
 */
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import WipBoardPage from '../../../pages/accounting/practice/wip';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(),
}));

const REFUSAL = 'taxRate must be between 0 and 100, got 101';
const group = {
  practiceClientId: 'pc-1', legalName: 'Acme Practice Client', linkCustomerId: 'cust-1',
  totalHours: 4, totalValue: 1000, oldestApprovedDate: '2026-01-05',
  entries: [{ id: 'te-1', entryDate: '2026-01-05', taskDescription: 'Audit', hours: 4, appliedRate: 250, lineTotal: 1000 }],
};

afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('shows the server’s refusal message, not "[object Object]"', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      return Response.json({ success: false, error: { code: 'BAD_REQUEST', message: REFUSAL } }, { status: 400 });
    }
    return Response.json({ success: true, data: [group] });
  });
  render(<WipBoardPage />);
  await screen.findByText('Acme Practice Client');
  fireEvent.click(screen.getAllByRole('checkbox')[0]!);
  fireEvent.click(screen.getByRole('button', { name: /generate invoice/i }));
  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
  expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
  expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
});
