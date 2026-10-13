/**
 * Posting an expense claim dated in a filed VAT period claims its input VAT
 * late (s16(3)); `expense-claims/[id]/post` returns `claim.lateClaim`, and the
 * claim page must tell the person (review round 2).
 */
import { chartAccount } from '../helpers/chartAccount';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: 'c1' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import Page from '../../../pages/accounting/expenses/[id]';

const claim = (status: string, extra: object = {}) => ({
  id: 'c1', claimNumber: 'EXP-0001', claimDate: '2026-06-22', employeeId: 'e1', title: 'Stationery',
  description: null, status, totalAmount: 115, totalVat: 15, approvedBy: null, approvedAt: null,
  rejectionReason: null, postedJeId: null, postedAt: null, submittedAt: '2026-06-22', lines: [], ...extra,
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const lateClaim = { claimDate: '2026-07-01', lockPeriod: { start: '2026-05-01', end: '2026-06-30' }, inputTax: 15 };

async function post(response: Response) {
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(ok({ claim: claim('approved') }))
    .mockResolvedValueOnce(ok([chartAccount('a1', '2300', 'Reimbursements', { accountType: 'liability' })]))
    .mockResolvedValueOnce(response);
  render(<Page />);
  fireEvent.click(await screen.findByText('Post to GL'));
  // The accounts are their own fetch; without the option the change leaves the
  // select at '' and 'Post' stays disabled (R-138).
  await screen.findAllByRole('option', { name: '2300 — Reimbursements' });
  fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'a1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Post' }));
}

describe('expense claim page — late claim notice', () => {
  beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.info).mockReset(); });

  it('tells the person the VAT was claimed in a later period', async () => {
    await post(ok({ claim: claim('posted', { lateClaim }) }));
    await waitFor(() => expect(notify.info).toHaveBeenCalledWith(
      'Input VAT of R15.00 claimed late, in the VAT period from 2026-07-01', 'Period 2026-05-01 to 2026-06-30 is filed.'));
  });

  it('says nothing for an ordinary post', async () => {
    await post(ok({ claim: claim('posted') }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect(notify.info).not.toHaveBeenCalled();
  });
});
