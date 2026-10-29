/** Versions bar (spec §10): the role × status matrix decides which buttons render; dialogs gate every action. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VersionsBar, canWriteRole, versionButtons, type VersionsBarProps } from '@/components/accounting/budgets/workspace/VersionsBar';
import { DEFAULT_WRITE_ROLES, canWrite } from '@/lib/auth/writeRoles';
import { validUnlockReason } from '@/components/accounting/budgets/workspace/VersionStatusDialogs';
import type { BudgetVersion } from '@/components/accounting/budgets/workspace/types';

afterEach(cleanup);

const version = (over: Partial<BudgetVersion> = {}): BudgetVersion => ({
  id: 'b0000000-0000-4000-8000-000000000001', fiscalYear: 2027, name: 'Original', kind: 'original', status: 'draft',
  basedOnVersionId: null, isPrimary: false, approvedBy: null, approvedAt: null, lockedBy: null,
  lockedAt: null, unlockedBy: null, unlockedAt: null, unlockReason: null, createdBy: 'u1',
  createdAt: '2026-10-01T00:00:00.000000Z', updatedAt: '2026-10-26T18:01:02.123456Z', amountCount: 6, total: 0, ...over,
});

const props = (over: Partial<VersionsBarProps> = {}): VersionsBarProps => ({
  versions: [version()], current: version(), role: 'owner', dirtyCount: 0, disabled: false, compareVersionId: null,
  onSelect: vi.fn(), onCompare: vi.fn(), onNewReforecast: vi.fn(), onAction: vi.fn(async () => null), ...over,
});

/** The buttons rendered in the desktop action group, by label. */
const rendered = () => within(screen.getByTestId('version-actions')).queryAllByRole('button').map((b) => b.textContent);

type Status = BudgetVersion['status'];
// [role, status, isPrimary] → the status buttons the bar must render, in order (spec §10 table).
const MATRIX: Array<[string, Status, boolean, string[]]> = [
  ['owner', 'draft', false, ['Approve', 'Set primary', 'Delete']],
  ['owner', 'draft', true, ['Approve']],
  ['owner', 'approved', false, ['Lock', 'Set primary', 'Delete']],
  ['owner', 'approved', true, ['Lock']],
  ['owner', 'locked', false, ['Unlock', 'Set primary']],
  ['owner', 'locked', true, ['Unlock']],
  ['admin', 'draft', false, ['Approve', 'Set primary', 'Delete']],
  ['admin', 'approved', false, ['Lock', 'Set primary', 'Delete']],
  ['admin', 'locked', false, ['Set primary']],
  ['admin', 'locked', true, []],
  ['manager', 'draft', false, ['Delete']],
  ['manager', 'draft', true, []],
  ['manager', 'approved', false, []],
  ['manager', 'locked', false, []],
  ['viewer', 'draft', false, []],
  ['viewer', 'approved', false, []],
  ['viewer', 'locked', false, []],
];

describe('role × status matrix', () => {
  it.each(MATRIX)('%s on a %s version (primary=%s) sees %j', (role, status, isPrimary, expected) => {
    const v = version({ status, isPrimary });
    render(<VersionsBar {...props({ role, current: v, versions: [v] })} />);
    const reforecast = ['owner', 'admin', 'manager'].includes(role) ? ['New reforecast'] : [];
    expect(rendered()).toEqual([...reforecast, ...expected]);
  });

  it('unlock is owner-only: an admin on a locked version gets no Unlock (pure matrix too)', () => {
    expect(versionButtons(version({ status: 'locked' }), 'admin').has('unlock')).toBe(false);
    expect(versionButtons(version({ status: 'locked' }), 'owner').has('unlock')).toBe(true);
    expect(versionButtons(null, 'owner').size).toBe(0);
    expect(versionButtons(version(), null).size).toBe(0);
  });
});

describe('write roles', () => {
  it('come from the server\'s list (@/lib/auth/writeRoles), not a copy', () => {
    expect(canWriteRole).toBe(canWrite);
    for (const role of [...DEFAULT_WRITE_ROLES, 'viewer', 'accountant', null]) expect(canWriteRole(role)).toBe(canWrite(role));
  });
});

describe('status chip', () => {
  it('names approved versions as audited and shows the lock date', () => {
    const { rerender } = render(<VersionsBar {...props({ current: version({ status: 'approved' }) })} />);
    expect(screen.getByTestId('version-status-chip')).toHaveTextContent('Approved, edits are audited');
    rerender(<VersionsBar {...props({ current: version({ status: 'locked', lockedAt: '2026-10-20T08:00:00.000000Z' }) })} />);
    expect(screen.getByTestId('version-status-chip')).toHaveTextContent('Locked on 20 October 2026');
  });
});

describe('transitions', () => {
  it('a dirty grid disables every transition and the switcher, and says why', () => {
    render(<VersionsBar {...props({ dirtyCount: 3 })} />);
    expect(screen.getByTestId('version-approve')).toBeDisabled();
    expect(screen.getByTestId('version-delete')).toBeDisabled();
    expect(screen.getByTestId('version-select')).toBeDisabled();
    expect(screen.getByTestId('versions-clean-note')).toHaveTextContent('Save or discard 3 changes first');
  });

  it('approve asks first, then runs the action and closes', async () => {
    const onAction = vi.fn(async () => null);
    render(<VersionsBar {...props({ onAction })} />);
    fireEvent.click(screen.getByTestId('version-approve'));
    expect(onAction).not.toHaveBeenCalled();
    const dialog = screen.getByTestId('version-dialog-approve');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByTestId('version-dialog-approve')).toBeNull());
    expect(onAction).toHaveBeenCalledWith({ action: 'approve' });
  });

  it('delete has a confirm; cancel sends nothing; a refusal stays on screen', async () => {
    const onAction = vi.fn(async () => 'This version is primary');
    render(<VersionsBar {...props({ onAction })} />);
    fireEvent.click(screen.getByTestId('version-delete'));
    fireEvent.click(within(screen.getByTestId('version-dialog-delete')).getByRole('button', { name: 'Cancel' }));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('version-delete'));
    fireEvent.click(within(screen.getByTestId('version-dialog-delete')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This version is primary');
    expect(onAction).toHaveBeenCalledWith({ action: 'delete' });
  });

  it('unlock needs a reason of 1–500 characters once trimmed, and sends it trimmed', async () => {
    const onAction = vi.fn(async () => null);
    render(<VersionsBar {...props({ current: version({ status: 'locked' }), onAction })} />);
    fireEvent.click(screen.getByTestId('version-unlock'));
    const dialog = screen.getByTestId('version-dialog-unlock');
    const accept = within(dialog).getByRole('button', { name: 'Unlock' });
    const field = within(dialog).getByLabelText('Reason (required)');
    expect(accept).toBeDisabled();
    fireEvent.change(field, { target: { value: '   ' } });
    expect(accept).toBeDisabled();
    fireEvent.change(field, { target: { value: 'x'.repeat(501) } });
    expect(accept).toBeDisabled();
    fireEvent.change(field, { target: { value: '  Board asked for Q3 revision  ' } });
    fireEvent.click(accept);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ action: 'unlock', reason: 'Board asked for Q3 revision' }));
    expect(validUnlockReason(` ${'y'.repeat(500)} `)).toHaveLength(500);
  });

  it('switching and comparing call back with the picked id', () => {
    const other = version({ id: 'b0000000-0000-4000-8000-000000000002', name: 'Reforecast Q2', kind: 'reforecast' });
    const onSelect = vi.fn();
    const onCompare = vi.fn();
    render(<VersionsBar {...props({ versions: [version(), other], onSelect, onCompare })} />);
    fireEvent.change(screen.getByTestId('version-select'), { target: { value: other.id } });
    expect(onSelect).toHaveBeenCalledWith(other.id);
    fireEvent.change(screen.getByTestId('version-compare'), { target: { value: other.id } });
    expect(onCompare).toHaveBeenCalledWith(other.id);
    fireEvent.change(screen.getByTestId('version-compare'), { target: { value: '' } });
    expect(onCompare).toHaveBeenLastCalledWith(null);
  });
});
