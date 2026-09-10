/**
 * K-072 — the s17(2)(a) advice the approver is supposed to see.
 *
 * `/api/accounting/expense-claims/[id]/approve` computes the advice BEFORE it
 * acts on the decision, precisely because the approver is the last person who
 * sees the claim before `postClaim` debits VAT Input with the sum of the line
 * `vatAmount`s. This page destructured `json.data.claim` and dropped everything
 * else, so the advice reached no screen: the denial was advisory in name and
 * invisible in practice.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, query: { id: 'c1' } }),
}));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/apiFetch', async (original) => ({
  ...await original<typeof import('@/lib/apiFetch')>(),
  apiFetch: vi.fn(),
}));
import { apiFetch } from '@/lib/apiFetch';
import Page from '../../../pages/accounting/expenses/[id]';

const ADVICE = 'Input VAT denied on this account (s17(2)(a)) — posting the gross amount instead';

const claim = (status: string) => ({
  id: 'c1', claimNumber: 'EXP-0001', claimDate: '2026-09-01', employeeId: 'e1',
  title: 'Client lunch', description: null, status, totalAmount: 1150, totalVat: 150,
  approvedBy: null, approvedAt: null, rejectionReason: null, postedJeId: null,
  postedAt: null, submittedAt: '2026-09-01', lines: [],
});

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), { status: 200 });
}

describe('expense claim detail — the approver is warned', () => {
  it('renders the advice the approve endpoint returned', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(ok({ claim: claim('submitted') }))
      .mockResolvedValueOnce(ok({ accounts: [] }))
      .mockResolvedValueOnce(ok({ claim: claim('approved'), warnings: [ADVICE] }));

    render(<Page />);
    fireEvent.click(await screen.findByText('Approve'));

    expect(await screen.findByText(ADVICE)).toBeTruthy();
  });

  it('shows nothing when the claim claims no denied input tax', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(ok({ claim: claim('submitted') }))
      .mockResolvedValueOnce(ok({ accounts: [] }))
      .mockResolvedValueOnce(ok({ claim: claim('approved'), warnings: [] }));

    render(<Page />);
    fireEvent.click(await screen.findByText('Approve'));

    // The transition landed — the Approve button is gone — and no banner with it.
    await waitFor(() => expect(screen.queryByText('Approve')).toBeNull());
    expect(screen.queryByText(ADVICE)).toBeNull();
  });
});
