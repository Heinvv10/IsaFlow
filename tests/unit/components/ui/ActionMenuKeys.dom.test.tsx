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
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';

vi.mock('next/link', () => ({ default: ({ children, href, ...r }: { children: React.ReactNode; href: string }) => <a href={href} {...r}>{children}</a> }));

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

const rect = (top: number, left: number, right: number) => ({ top, bottom: top + 24, left, right, width: right - left, height: 24, x: left, y: top, toJSON: () => ({}) } as DOMRect);
const menu = () => screen.getByRole('menu');

describe('ActionMenu round 3 (WP4b review)', () => {
  it('every item disabled: the menu itself takes focus; Escape, Tab and the arrows still work (VersionsBar while unsaved)', () => {
    render(<ActionMenu triggerLabel="Version actions" items={[{ label: 'A', onClick: vi.fn(), disabled: true }, { label: 'B', onClick: vi.fn(), disabled: true }]} />);
    const trigger = screen.getByRole('button', { name: 'Version actions' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(menu());
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(menu());
    expect(fireEvent.keyDown(menu(), { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.keyDown(menu(), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape on the trigger while the menu is open closes it', () => {
    render(<ActionMenu triggerLabel="M" items={[{ label: 'A', onClick: vi.fn() }]} />);
    const trigger = screen.getByRole('button', { name: 'M' });
    fireEvent.click(trigger);
    expect(fireEvent.keyDown(trigger, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a click on the menu\'s padding keeps focus in the menu, and its keys go on working', () => {
    render(<ActionMenu triggerLabel="M" items={[{ label: 'A', onClick: vi.fn() }, { label: 'B', onClick: vi.fn() }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'M' }));
    // The menu is focusable (tabIndex -1), so a click on its padding moves focus INTO it, not to <body>. happy-dom
    // focuses any element, so the attribute is asserted here; the click itself is checked in Chromium (z31 / the report).
    expect(menu().getAttribute('tabindex')).toBe('-1');
    fireEvent.mouseDown(menu());
    menu().focus();
    expect(document.activeElement).toBe(menu());
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'A' }));
  });

  it('Ctrl/Shift/Cmd+Enter on a link item is the browser\'s (new tab): onClick does not run', () => {
    const go = vi.fn();
    render(<ActionMenu triggerLabel="M" items={[{ label: 'Import', href: '/import', onClick: go }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'M' }));
    const link = screen.getByRole('menuitem', { name: 'Import' });
    for (const mod of [{ ctrlKey: true }, { shiftKey: true }, { metaKey: true }]) {
      expect(fireEvent.keyDown(link, { key: 'Enter', ...mod })).toBe(true); // not prevented
    }
    expect(go).not.toHaveBeenCalled();
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('kept inside the viewport horizontally', () => {
    render(<ActionMenu triggerLabel="M" items={[{ label: 'A', onClick: vi.fn() }]} />);
    const trigger = screen.getByRole('button', { name: 'M' });
    const spy = vi.spyOn(trigger, 'getBoundingClientRect');
    spy.mockReturnValue(rect(100, window.innerWidth - 4, window.innerWidth + 20)); // trigger partly off the right edge
    fireEvent.click(trigger);
    expect(menu().style.right).toBe('8px');
    fireEvent.click(trigger);
    spy.mockReturnValue(rect(100, 0, 24)); // at the left edge: a right-aligned menu would leave the viewport
    fireEvent.click(trigger);
    expect(menu().style.left).toBe('8px');
    expect(menu().style.right).toBe('');
  });

  it('the side is chosen once, when it opens: a scroll moves it but never flips it', () => {
    render(<ActionMenu triggerLabel="M" items={[{ label: 'A', onClick: vi.fn() }, { label: 'B', onClick: vi.fn() }]} />);
    const trigger = screen.getByRole('button', { name: 'M' });
    const spy = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(100, 0, 300));
    fireEvent.click(trigger);
    expect(menu().getAttribute('data-side')).toBe('down');
    spy.mockReturnValue(rect(window.innerHeight - 30, 0, 300));
    fireEvent.scroll(window);
    expect(menu().getAttribute('data-side')).toBe('down');
    expect(menu().style.top).toBe(`${window.innerHeight - 30 + 24 + 4}px`); // it followed the trigger
  });

  it('the Space that picked an item does not click the trigger open again on its keyup', () => {
    const pickA = vi.fn();
    render(<ActionMenu triggerLabel="M" items={[{ label: 'A', onClick: pickA }]} />);
    const trigger = screen.getByRole('button', { name: 'M' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: ' ' });
    expect(pickA).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    expect(fireEvent.keyUp(trigger, { key: ' ' })).toBe(false); // its default (a click) is cancelled
    expect(fireEvent.keyUp(trigger, { key: ' ' })).toBe(true); // a later, ordinary Space is the button's own
  });

  it('items changing while open: focus and the roving tabIndex stay on the same item, found by its label', () => {
    const items = (extra: boolean): ActionMenuItem[] => [
      ...(extra ? [{ label: 'New', onClick: vi.fn() }, { label: 'Newer', onClick: vi.fn() }] : []),
      { label: 'Import', onClick: vi.fn() }, { label: 'Export', onClick: vi.fn() },
    ];
    const { rerender } = render(<ActionMenu triggerLabel="M" items={items(false)} />);
    fireEvent.click(screen.getByRole('button', { name: 'M' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    const exp = () => screen.getByRole('menuitem', { name: 'Export' });
    expect(document.activeElement).toBe(exp());
    rerender(<ActionMenu triggerLabel="M" items={items(true)} />);
    expect(document.activeElement).toBe(exp());
    expect(exp().tabIndex).toBe(0);
    expect(screen.getByRole('menuitem', { name: 'Import' }).tabIndex).toBe(-1);
  });
});
