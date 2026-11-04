/**
 * Budgets P5-6 (decision 9a): an approve refused because budget slices are not approved offers the
 * OWNER "Approve anyway" with a required reason, sent as `force: true`; an admin only sees the refusal.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionsBar, type VersionsBarProps } from '@/components/accounting/budgets/workspace/VersionsBar';
import type { BudgetVersion } from '@/components/accounting/budgets/workspace/types';

afterEach(cleanup);

const version: BudgetVersion = {
  id: 'b0000000-0000-4000-8000-000000000001', fiscalYear: 2027, name: 'Original', kind: 'original', status: 'draft',
  basedOnVersionId: null, isPrimary: false, approvedBy: null, approvedAt: null, lockedBy: null,
  lockedAt: null, unlockedBy: null, unlockedAt: null, unlockReason: null, createdBy: 'u1',
  createdAt: '2026-10-01T00:00:00.000000Z', updatedAt: '2026-10-26T18:01:02.123456Z', amountCount: 6, total: 0,
};
const REFUSAL = '1 budget slice is not approved yet: CC1 OPS (open). Approve them, or (owner) approve anyway with a reason';
const props = (over: Partial<VersionsBarProps>): VersionsBarProps => ({
  versions: [version], current: version, role: 'owner', dirtyCount: 0, disabled: false, compareVersionId: null,
  onSelect: vi.fn(), onCompare: vi.fn(), onNewReforecast: vi.fn(), onAction: vi.fn(async () => null), ...over,
});

describe('approve over open budget slices', () => {
  it('owner: the refusal turns into "Approve anyway", which needs a reason and sends force', async () => {
    const onAction = vi.fn(async (req: { force?: boolean }) => (req.force ? null : REFUSAL));
    render(<VersionsBar {...props({ onAction })} />);
    fireEvent.click(screen.getByTestId('version-approve'));
    fireEvent.click(within(screen.getByTestId('version-dialog-approve')).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByTestId('version-dialog-force-approve');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('not approved yet');
    const go = within(dialog).getByTestId('version-force-approve');
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason (required)'), { target: { value: '  Board meets today ' } });
    fireEvent.click(go);
    await waitFor(() => expect(screen.queryByTestId('version-dialog-force-approve')).toBeNull());
    expect(onAction).toHaveBeenLastCalledWith({ action: 'approve', force: true, reason: 'Board meets today' });
  });

  it('admin: the refusal stays a refusal (no force)', async () => {
    const onAction = vi.fn(async () => REFUSAL);
    render(<VersionsBar {...props({ role: 'admin', onAction })} />);
    fireEvent.click(screen.getByTestId('version-approve'));
    fireEvent.click(within(screen.getByTestId('version-dialog-approve')).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not approved yet');
    expect(screen.queryByTestId('version-dialog-force-approve')).toBeNull();
  });
});
