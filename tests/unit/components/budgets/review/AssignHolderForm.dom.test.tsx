/**
 * Budgets P5-6 r2: the assign form's account limit. Picking accounts sends them as `glAccountIds`;
 * picking none sends null (every account of the slice). Only revenue and expense accounts are offered.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  assignHolder: vi.fn(async () => ({ label: 'CC1 OPS Operations' })),
  fetchYears: vi.fn(async () => ({ years: [{ fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', kind: 'normal', monthKeys: [] }], current: 2027 })),
  fetchDraftVersions: vi.fn(async () => [{ id: 'v1', label: 'FY27 Original' }]),
  fetchHolderCandidates: vi.fn(async () => [{ id: 'm1', label: 'Mandla (manager)', role: 'manager' }]),
  fetchSliceMembers: vi.fn(async () => [{ id: 'c1', label: 'OPS Operations' }]),
  fetchBudgetAccounts: vi.fn(async () => [{ id: 'a1', label: '5000 Rent' }, { id: 'a2', label: '5100 Travel' }]),
}));
vi.mock('@/components/accounting/budgets/review/reviewClient', () => client);

import { AssignHolderForm } from '@/components/accounting/budgets/review/AssignHolderForm';

afterEach(cleanup);

async function filled() {
  render(<AssignHolderForm onAssigned={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('option', { name: 'Mandla (manager)' })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Holder (manager or above)'), { target: { value: 'm1' } });
  await waitFor(() => expect(screen.getByRole('option', { name: 'OPS Operations' })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('CC1'), { target: { value: 'c1' } });
  await waitFor(() => expect(screen.getByRole('option', { name: '5100 Travel' })).toBeInTheDocument());
}

describe('AssignHolderForm account limit', () => {
  it('the picked accounts are sent as glAccountIds', async () => {
    await filled();
    const list = screen.getByLabelText('Accounts (optional; none = every account)') as HTMLSelectElement;
    for (const o of Array.from(list.options)) o.selected = o.value === 'a2';
    fireEvent.change(list);
    fireEvent.click(screen.getByTestId('assign-holder-submit'));
    await waitFor(() => expect(client.assignHolder).toHaveBeenCalled());
    expect(client.assignHolder).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'm1', cc1Id: 'c1', glAccountIds: ['a2'] }));
  });

  it('no account picked: glAccountIds null (every account of the slice)', async () => {
    await filled();
    fireEvent.click(screen.getByTestId('assign-holder-submit'));
    await waitFor(() => expect(client.assignHolder).toHaveBeenCalled());
    expect(client.assignHolder).toHaveBeenLastCalledWith(expect.objectContaining({ glAccountIds: null }));
  });
});
