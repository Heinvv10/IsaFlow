/**
 * ActionMenu as a WAI-ARIA menu button. Opening moves focus onto an item and the items rove (one tabIndex 0); Arrow,
 * Home and End move focus; Enter and Space act on the item that HAS focus and are preventDefault-ed (the browser's own
 * activation would click again, or click whatever took focus next); Escape closes back to the trigger; Tab and focus
 * leaving close it. Keys it handles do not bubble out of the (portalled) menu to the trigger's ancestors. Closed, it
 * leaves keys alone. It opens upward when there is no room below. happy-dom does not simulate default activation, so
 * this asserts `defaultPrevented` and calls.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActionMenu } from '@/components/ui/ActionMenu';

afterEach(cleanup);

function setup(onOuterKey = vi.fn()) {
  const first = vi.fn(), second = vi.fn(), third = vi.fn();
  render(
    <div onKeyDown={onOuterKey}>
      <ActionMenu triggerLabel="Row actions" items={[
        { label: 'First', onClick: first }, { label: 'Off', onClick: vi.fn(), disabled: true },
        { label: 'Second', onClick: second }, { label: 'Exclude', onClick: third, tone: 'destructive' },
      ]} />
      <button type="button">Elsewhere</button>
    </div>,
  );
  const trigger = screen.getByRole('button', { name: 'Row actions' });
  /** fireEvent returns false when a listener called preventDefault. */
  const press = (key: string) => !fireEvent.keyDown(document.activeElement ?? document.body, { key });
  const item = (name: string) => screen.getByRole('menuitem', { name });
  return { first, second, third, trigger, press, item, onOuterKey };
}

describe('ActionMenu keys', () => {
  it('opening moves focus to the first item; the items rove (one tabIndex 0)', () => {
    const { trigger, item } = setup();
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(item('First'));
    expect(item('First').tabIndex).toBe(0);
    expect(item('Second').tabIndex).toBe(-1);
  });

  it('Arrow keys skip disabled items and wrap; Home / End jump; ArrowUp on the trigger opens on the last item', () => {
    const { trigger, item, press } = setup();
    trigger.focus();
    fireEvent.click(trigger);
    expect(press('ArrowDown')).toBe(true);
    expect(document.activeElement).toBe(item('Second'));
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Exclude'));
    press('ArrowDown');
    expect(document.activeElement).toBe(item('First'));
    press('End');
    expect(document.activeElement).toBe(item('Exclude'));
    press('Home');
    expect(document.activeElement).toBe(item('First'));
    press('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(press('ArrowUp')).toBe(true);
    expect(document.activeElement).toBe(item('Exclude'));
  });

  it('Enter acts on the item that has focus, once, and is preventDefault-ed; focus returns to the trigger', () => {
    const { trigger, press, first, second, third } = setup();
    trigger.focus();
    fireEvent.click(trigger);
    press('ArrowDown');
    expect(press('Enter')).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Space acts like Enter', () => {
    const { trigger, press, first } = setup();
    trigger.focus();
    fireEvent.click(trigger);
    expect(press(' ')).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('Tab closes it and hands focus back to the trigger (the browser then moves on); Tab is not prevented', () => {
    const { trigger, press } = setup();
    trigger.focus();
    fireEvent.click(trigger);
    expect(press('Tab')).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('focus leaving the menu for something else closes it', () => {
    const { trigger, item } = setup();
    fireEvent.click(trigger);
    fireEvent.blur(item('First'), { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keys the menu handles do not bubble to the trigger\'s ancestors (a grid with hotkeys)', () => {
    const outer = vi.fn();
    const { trigger, press } = setup(outer);
    fireEvent.click(trigger);
    press('ArrowDown'); press('x'); press('Enter');
    expect(outer).not.toHaveBeenCalled();
  });

  it('closed: Enter and Escape are left to the browser', () => {
    const { trigger, press } = setup();
    trigger.focus();
    expect(press('Enter')).toBe(false);
    expect(press('Escape')).toBe(false);
  });

  it('opens down when there is room, up near the bottom of the viewport', () => {
    const { trigger } = setup();
    const at = (top: number) => vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 24, left: 0, right: 24, width: 24, height: 24, x: 0, y: top, toJSON: () => ({}) } as DOMRect);
    at(100);
    fireEvent.click(trigger);
    expect(screen.getByRole('menu').getAttribute('data-side')).toBe('down');
    fireEvent.click(trigger);
    at(window.innerHeight - 30);
    fireEvent.click(trigger);
    expect(screen.getByRole('menu').getAttribute('data-side')).toBe('up');
  });
});
