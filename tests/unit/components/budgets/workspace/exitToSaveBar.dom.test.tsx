/**
 * Tab off the grid (round 1 QA-1 / ARCH-L): `exitToSaveBar` is BudgetWorkspace's `onExit`. It moves
 * focus to the save bar's Save button only when that button is there and enabled, and reports
 * whether it did, so the grid prevents the browser's Tab only then and otherwise lets focus leave
 * natively (no keyboard trap on a locked, read-only or clean grid). Backward never takes focus.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitToSaveBar } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { SaveBar } from '@/components/accounting/budgets/workspace/SaveBar';

afterEach(cleanup);

const bar = (dirtyCount: number, saving = false) => (
  <SaveBar dirtyCount={dirtyCount} saveState={saving ? { status: 'saving' } : { status: 'idle' }} readOnly={false} onSave={vi.fn()} onDiscard={vi.fn()} />
);

describe('exitToSaveBar', () => {
  it('forward with unsaved changes: focuses Save and says so', () => {
    render(bar(2));
    expect(exitToSaveBar('forward')).toBe(true);
    expect(document.activeElement).toHaveTextContent('Save');
  });

  it('no save bar (clean, locked or read-only): leaves focus alone and says so', () => {
    render(bar(0));
    const before = document.activeElement;
    expect(exitToSaveBar('forward')).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it('Save disabled while saving: does not take focus', () => {
    render(bar(2, true));
    expect(exitToSaveBar('forward')).toBe(false);
  });

  it('backward (Shift+Tab at the first column) never takes focus', () => {
    render(bar(2));
    expect(exitToSaveBar('backward')).toBe(false);
  });
});
