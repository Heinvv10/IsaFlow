/**
 * ActionMenu, WP4b review rounds 4-5: keys on the menu itself act from the ACTIVE item (a modified Enter there only
 * focuses a link item); Ctrl/Shift/Cmd+Enter on a link closes back to the trigger; Escape on the trigger goes no further,
 * not even to a native listener above it; the horizontal clamp uses the menu's measured width; a list that empties and
 * refills while open starts again on its first item. happy-dom has no layout, so the width is stubbed on offsetWidth.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { arrowTarget } from '@/components/ui/actionMenuParts';

vi.mock('next/link', () => ({ default: ({ children, href, ...r }: { children: React.ReactNode; href: string }) => <a href={href} {...r}>{children}</a> }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const menu = () => screen.getByRole('menu');
const mi = (name: string) => screen.getByRole('menuitem', { name });
const abc = (fns: Record<string, () => void> = {}): ActionMenuItem[] =>
  ['A', 'B', 'C'].map(label => ({ label, onClick: fns[label] ?? vi.fn() }));

describe('keys on the menu itself (after a click on its padding) act from the active item', () => {
  it('ArrowUp from the menu with A active goes to C (the wrap from A), ArrowDown with B active goes to C', () => {
    render(<ActionMenu triggerLabel="M" items={abc()} />);
    fireEvent.click(screen.getByRole('button', { name: 'M' }));
    menu().focus();
    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(mi('C'));
    fireEvent.mouseEnter(mi('B'));
    menu().focus();
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(mi('C'));
  });

  it('Enter and Space on the menu act on the active item', () => {
    const b = vi.fn();
    render(<ActionMenu triggerLabel="M" items={abc({ B: b })} />);
    const trigger = screen.getByRole('button', { name: 'M' });
    for (const key of ['Enter', ' ']) {
      fireEvent.click(trigger);
      fireEvent.mouseEnter(mi('B'));
      menu().focus();
      expect(fireEvent.keyDown(menu(), { key })).toBe(false);
      expect(screen.queryByRole('menu')).toBeNull();
    }
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('Ctrl/Shift/Cmd+Enter on the menu with a link active: focus goes to the link, nothing runs; a plain Enter picks it', () => {
    const go = vi.fn();
    render(<ActionMenu triggerLabel="M" items={[{ label: 'A', onClick: vi.fn() }, { label: 'Import', href: '/import', onClick: go }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'M' }));
    fireEvent.mouseEnter(mi('Import'));
    for (const mod of [{ ctrlKey: true }, { shiftKey: true }, { metaKey: true }]) {
      menu().focus();
      fireEvent.keyDown(menu(), { key: 'Enter', ...mod });
      expect(go).not.toHaveBeenCalled();
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(document.activeElement).toBe(mi('Import'));
    }
    menu().focus();
    fireEvent.keyDown(menu(), { key: 'Enter' });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('with no active item, ArrowDown goes to the first enabled item and ArrowUp to the last', () => {
    const enabled = [0, 2, 3];
    expect(arrowTarget(enabled, -1, 'ArrowDown')).toBe(0);
    expect(arrowTarget(enabled, -1, 'ArrowUp')).toBe(3);
    expect(arrowTarget(enabled, 0, 'ArrowUp')).toBe(3);
    expect(arrowTarget(enabled, 3, 'ArrowDown')).toBe(0);
    expect(arrowTarget([], -1, 'ArrowDown')).toBeUndefined();
  });
});

describe('closing', () => {
  it('Ctrl+Enter on a link item: the menu closes back to the trigger, not to <body>', async () => {
    render(<ActionMenu triggerLabel="M" items={[{ label: 'Import', href: '/import', onClick: vi.fn() }]} />);
    const trigger = screen.getByRole('button', { name: 'M' });
    fireEvent.click(trigger);
    fireEvent.keyDown(mi('Import'), { key: 'Enter', ctrlKey: true });
    await act(async () => { await new Promise<void>(r => setTimeout(r, 0)); });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape on the trigger while open reaches no listener above it: React, or NATIVE on an ancestor, #root, document', () => {
    const outer = vi.fn(), nativeAncestor = vi.fn(), nativeRoot = vi.fn(), doc = vi.fn();
    document.addEventListener('keydown', doc);
    try {
      const { container } = render(<div data-testid="dialog" onKeyDown={outer}><ActionMenu triggerLabel="M" items={abc()} /></div>);
      container.addEventListener('keydown', nativeRoot); // React's root container (#root in the app)
      screen.getByTestId('dialog').addEventListener('keydown', nativeAncestor);
      const trigger = screen.getByRole('button', { name: 'M' });
      fireEvent.click(trigger);
      expect(fireEvent.keyDown(trigger, { key: 'Escape' })).toBe(false);
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      for (const l of [outer, nativeAncestor, nativeRoot, doc]) expect(l).not.toHaveBeenCalled();
      fireEvent.keyDown(trigger, { key: 'Escape' }); // closed: Escape is the dialog's again
      for (const l of [outer, nativeAncestor, nativeRoot, doc]) expect(l).toHaveBeenCalledTimes(1);
    } finally { document.removeEventListener('keydown', doc); }
  });
});

describe('the horizontal clamp uses the menu\'s real width', () => {
  const rect = (left: number, right: number) => ({ top: 100, bottom: 124, left, right, width: right - left, height: 24, x: left, y: 100, toJSON: () => ({}) } as DOMRect);
  const at = (vw: number, menuW: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: vw });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? menuW : 0;
    });
  };
  const original = window.innerWidth;
  afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: original }); });

  for (const vw of [320, 390]) {
    it(`a 260px row menu at ${vw}px keeps 8px on both sides`, () => {
      at(vw, 260);
      render(<ActionMenu triggerLabel="M" items={abc()} />);
      const trigger = screen.getByRole('button', { name: 'M' });
      // A trigger whose right edge is at 224px: right-aligned, a 260px menu would start at -36px (a 180px one would fit).
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(200, 224));
      fireEvent.click(trigger);
      expect(menu().style.left).toBe('8px');
      expect(menu().style.right).toBe('');
      expect(8 + 260).toBeLessThanOrEqual(vw - 8);
      expect(menu().style.maxWidth).toBe('calc(100vw - 16px)'); // a wider menu is capped inside the margins
    });
  }

  it('a trigger near the right edge with room on the left stays right-aligned to it', () => {
    at(390, 260);
    render(<ActionMenu triggerLabel="M" items={abc()} />);
    const trigger = screen.getByRole('button', { name: 'M' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(346, 380));
    fireEvent.click(trigger);
    expect(menu().style.right).toBe('10px');
  });
});

describe('items emptied and refilled while open', () => {
  it('the first enabled item becomes active again (focus and tabIndex 0)', () => {
    const { rerender } = render(<ActionMenu triggerLabel="M" items={abc()} />);
    fireEvent.click(screen.getByRole('button', { name: 'M' }));
    rerender(<ActionMenu triggerLabel="M" items={[]} />);
    expect(document.activeElement).toBe(menu());
    rerender(<ActionMenu triggerLabel="M" items={abc()} />);
    expect(document.activeElement).toBe(mi('A'));
    expect(mi('A').tabIndex).toBe(0);
  });
});
