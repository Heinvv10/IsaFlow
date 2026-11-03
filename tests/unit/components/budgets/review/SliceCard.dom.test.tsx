/**
 * Budgets P5-6: a slice card offers only the moves the viewer may make (a holder submits an open or
 * returned slice of a draft; an owner/admin approves or returns a submitted one, the return needing a
 * note) and keeps a refusal on the card.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { moveSlice, unassignHolder } = vi.hoisted(() => ({ moveSlice: vi.fn(), unassignHolder: vi.fn() }));
vi.mock('@/components/accounting/budgets/review/reviewClient', () => ({ moveSlice, unassignHolder }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a> }));

import { SliceCard } from '@/components/accounting/budgets/review/SliceCard';
import type { SliceReview } from '@/modules/accounting/services/budgets/sliceReviewRead';

afterEach(cleanup);
beforeEach(() => { moveSlice.mockReset(); unassignHolder.mockReset(); });

const slice = (over: Partial<SliceReview> = {}): SliceReview => ({
  id: 's1', versionId: 'v1', versionName: 'Original', fiscalYear: 2027, versionStatus: 'draft', cc1Id: 'c', cc2Id: null, buId: null,
  label: 'CC1 OPS Operations', status: 'open', dueDate: '2030-05-01', submittedBy: null, submittedAt: null, decidedBy: null, decidedAt: null,
  decisionNote: null, holders: [{ id: 'bh1', userId: 'h1', name: 'Hanna', glAccountIds: null }], ...over,
});
const card = (s: SliceReview, userId: string, reviewer: boolean, onChanged = vi.fn(), onRemoved = vi.fn()) =>
  render(<ul><SliceCard slice={s} userId={userId} reviewer={reviewer} today="2030-05-10" onChanged={onChanged} onRemoved={onRemoved} /></ul>);

describe('SliceCard', () => {
  it('a holder submits an open slice; the overdue date is flagged', async () => {
    const onChanged = vi.fn();
    moveSlice.mockResolvedValueOnce(slice({ status: 'submitted' }));
    card(slice(), 'h1', false, onChanged);
    expect(screen.getByText('Overdue: 2030-05-01')).toBeInTheDocument();
    expect(screen.queryByTestId('slice-approve')).toBeNull();
    fireEvent.click(screen.getByTestId('slice-submit'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'submitted' })));
    expect(moveSlice).toHaveBeenCalledWith('s1', 'submit', undefined);
  });

  it('nobody but a holder submits; nothing moves on a version that is not a draft', () => {
    card(slice(), 'someone-else', true);
    expect(screen.queryByTestId('slice-submit')).toBeNull();
    cleanup();
    card(slice({ versionStatus: 'approved', status: 'submitted' }), 'o1', true);
    expect(screen.queryByTestId('slice-approve')).toBeNull();
  });

  it('a reviewer returns a submitted slice only with a note; a refusal stays on the card', async () => {
    moveSlice.mockRejectedValueOnce(new Error('boom'));
    card(slice({ status: 'submitted' }), 'o1', true);
    expect(screen.queryByTestId('slice-submit')).toBeNull();
    fireEvent.click(screen.getByTestId('slice-return'));
    const confirm = screen.getByTestId('slice-return-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What should change? (required)'), { target: { value: ' Trim June ' } });
    fireEvent.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work. Try again.');
    expect(moveSlice).toHaveBeenCalledWith('s1', 'return', 'Trim June');
  });

  it('a reviewer removes a holder of an open slice after confirming; not of a submitted slice, and never a holder', async () => {
    const onRemoved = vi.fn();
    unassignHolder.mockResolvedValueOnce({ sliceDeleted: true });
    card(slice(), 'o1', true, vi.fn(), onRemoved);
    fireEvent.click(screen.getByTestId('holder-remove-bh1'));
    expect(unassignHolder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('holder-remove-confirm-bh1'));
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(unassignHolder).toHaveBeenCalledWith('bh1');
    cleanup();
    card(slice({ status: 'submitted' }), 'o1', true);
    expect(screen.queryByTestId('holder-remove-bh1')).toBeNull();
    cleanup();
    card(slice(), 'h1', false);
    expect(screen.queryByTestId('holder-remove-bh1')).toBeNull();
  });
});
