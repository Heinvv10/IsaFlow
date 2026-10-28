/**
 * ActionMenu reads its keys on `document` while open. A key it acts on must be preventDefault-ed:
 * otherwise the browser's own activation runs too (Enter clicking whatever just took focus: the
 * dialog the item opened, or the trigger, which re-opens the menu). Closed, it leaves keys alone.
 * happy-dom does not simulate default activation, so this asserts `defaultPrevented`.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ActionMenu } from '@/components/ui/ActionMenu';

function setup() {
  const onPick = vi.fn();
  render(<ActionMenu triggerLabel="Row actions" items={[{ label: 'First', onClick: onPick }, { label: 'Second', onClick: vi.fn() }]} />);
  const trigger = screen.getByRole('button', { name: 'Row actions' });
  /** fireEvent returns false when a listener called preventDefault. */
  const prevented = (key: string) => !fireEvent.keyDown(document.activeElement ?? document.body, { key });
  return { onPick, trigger, prevented };
}

describe('ActionMenu keys', () => {
  it('open: ArrowDown, Enter on the highlighted item and Escape are all preventDefault-ed', () => {
    const { onPick, trigger, prevented } = setup();
    trigger.focus();
    fireEvent.click(trigger);
    expect(prevented('ArrowDown')).toBe(true);
    expect(prevented('Enter')).toBe(true);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    expect(prevented('Escape')).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closed: Enter and Escape are left to the browser', () => {
    const { trigger, prevented } = setup();
    trigger.focus();
    expect(prevented('Enter')).toBe(false);
    expect(prevented('Escape')).toBe(false);
  });

  it('open with nothing highlighted: Enter is not taken over (the trigger keeps its native Enter)', () => {
    const { onPick, trigger, prevented } = setup();
    trigger.focus();
    fireEvent.click(trigger);
    expect(prevented('Enter')).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });
});
