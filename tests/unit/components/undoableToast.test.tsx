/**
 * Master plan U (M9): notify.undoable. The real notify over the real Toaster: the button is a real button, Ctrl or
 * Cmd+Z reaches it from anywhere, a live region that was there first announces it, the undo runs once however often
 * it is asked for, the toast stays up while it is hovered or focused, and it goes on its own after durationMs.
 */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import toast, { Toaster } from 'react-hot-toast';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify } from '@/utils/toast';
import { UndoAnnouncer } from '@/utils/UndoAnnouncer';

const REMOVE_DELAY = 1100; // react-hot-toast keeps a dismissed toast mounted for 1 s

function open(onUndo = vi.fn(), opts: { durationMs?: number; message?: string } = {}) {
  render(<><UndoAnnouncer /><Toaster /></>);
  act(() => { notify.undoable('Transaction excluded', { onUndo, ...opts }); });
  return onUndo;
}
const surface = () => screen.getByTestId('undo-toast');
const gone = () => screen.queryByTestId('undo-toast');
const undo = () => screen.getByRole('button', { name: 'Undo' });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** Two steps: the library schedules a dismissed toast's removal only after the render that follows the dismiss. */
const waitOut = (ms: number) => { advance(ms); advance(REMOVE_DELAY); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  act(() => { toast.remove(); });
  cleanup();
  vi.useRealTimers();
});

describe('notify.undoable', () => {
  it('announces through a polite region that was on the page before the toast: one that arrives with its text is not read', () => {
    render(<><UndoAnnouncer /><Toaster /></>);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');

    act(() => { notify.undoable('Transaction allocated', { onUndo: vi.fn(), message: 'What was learned is kept.' }); });

    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('Transaction allocated. What was learned is kept. Press Control Z to undo.');
  });

  it('the same sentence twice is a new announcement, not an unchanged region', () => {
    open();
    const first = screen.getByRole('status').firstElementChild;
    act(() => { notify.undoable('Transaction excluded', { onUndo: vi.fn() }); });
    expect(screen.getByRole('status').firstElementChild).not.toBe(first);
    expect(screen.getByRole('status').firstElementChild?.textContent).toBe(first?.textContent);
  });

  it('clears the region when the offer ends: a screen reader that walks there later finds no stale offer', () => {
    open(vi.fn(), { durationMs: 2000 });
    expect(screen.getByRole('status').textContent).not.toBe('');
    advance(2000);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('an older offer ending leaves a newer one\'s words alone', () => {
    open(vi.fn(), { durationMs: 2000 });
    advance(1000);
    act(() => { notify.undoable('Transaction allocated', { onUndo: vi.fn() }); });
    advance(1000);
    expect(screen.getByRole('status').textContent).toContain('Transaction allocated.');
  });

  it('StrictMode\'s second effect run leaves the words in place', () => {
    render(<StrictMode><UndoAnnouncer /><Toaster /></StrictMode>);
    act(() => { notify.undoable('Transaction excluded', { onUndo: vi.fn() }); });
    expect(screen.getByRole('status').textContent).toContain('Transaction excluded.');
  });

  it('does not cut the message off: it may say what undo does not do', () => {
    open(vi.fn(), { message: 'What was learned is kept.' });
    expect(screen.getByText('What was learned is kept.').className).not.toContain('truncate');
  });

  it('is a real button that Tab can reach', () => {
    open();
    expect(undo().tagName).toBe('BUTTON');
    expect(undo().getAttribute('type')).toBe('button');
    expect(undo().tabIndex).toBe(0);
  });

  it('shows the key, and tells assistive technology about it', () => {
    open();
    expect(surface().textContent).toContain('Ctrl+Z');
    expect(undo().getAttribute('aria-keyshortcuts')).toBe('Control+Z Meta+Z');
    expect(screen.getByRole('button', { name: 'Undo' })).toBe(undo());
  });

  it('runs the undo once, however often it is clicked', () => {
    const onUndo = open();
    const button = undo();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('goes away when the undo runs', () => {
    open();
    fireEvent.click(undo());
    advance(REMOVE_DELAY);
    expect(gone()).toBeNull();
  });

  it('dismisses itself after 8 seconds by default, and not before', () => {
    open();
    advance(7900);
    expect(surface()).toBeTruthy();
    waitOut(100);
    expect(gone()).toBeNull();
  });

  it('honours durationMs', () => {
    open(vi.fn(), { durationMs: 2000 });
    waitOut(2000);
    expect(gone()).toBeNull();
  });

  it('pauses while hovered and carries on with the time that was left', () => {
    open();
    advance(5000);
    fireEvent.mouseEnter(surface());
    waitOut(60_000);
    expect(surface()).toBeTruthy();
    fireEvent.mouseLeave(surface());
    advance(2900);
    expect(surface()).toBeTruthy();
    waitOut(100);
    expect(gone()).toBeNull();
  });

  it('pauses while focus is inside it', () => {
    open();
    fireEvent.focus(undo());
    waitOut(60_000);
    expect(surface()).toBeTruthy();
    fireEvent.blur(undo());
    waitOut(8000);
    expect(gone()).toBeNull();
  });

  it('stays paused when the pointer leaves while the button still has focus', () => {
    open();
    fireEvent.mouseEnter(surface());
    fireEvent.focus(undo());
    fireEvent.mouseLeave(surface());
    waitOut(60_000);
    expect(surface()).toBeTruthy();
  });

  describe('Ctrl or Cmd+Z', () => {
    const press = (target: Element, init: KeyboardEventInit = { ctrlKey: true }) => fireEvent.keyDown(target, { key: 'z', ...init });

    it.each([[{ ctrlKey: true }], [{ metaKey: true }]])('%o from the page runs the undo and takes the toast away', (init) => {
      const onUndo = open();
      expect(document.activeElement).not.toBe(undo());
      press(document.body, init);
      expect(onUndo).toHaveBeenCalledTimes(1);
      waitOut(0);
      expect(gone()).toBeNull();
    });

    it('takes the browser\'s own undo out of the way only when it acts', () => {
      open();
      expect(press(document.body), 'false: default prevented').toBe(false);
    });

    it('a second press finds nothing left to undo', () => {
      const onUndo = open();
      press(document.body);
      press(document.body);
      expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['plain z', { }],
      ['Ctrl+Shift+Z, which is redo', { ctrlKey: true, shiftKey: true }],
      ['Ctrl+Alt+Z', { ctrlKey: true, altKey: true }],
      ['a held key', { ctrlKey: true, repeat: true }],
    ])('%s does nothing', (_n, init) => {
      const onUndo = open();
      press(document.body, init);
      expect(onUndo).not.toHaveBeenCalled();
    });

    it.each(['input', 'textarea', 'select'])('a %s keeps its own Ctrl+Z', (tag) => {
      const onUndo = open();
      const field = document.body.appendChild(document.createElement(tag));
      expect(press(field), 'left to the field').toBe(true);
      field.remove();
      expect(onUndo).not.toHaveBeenCalled();
    });

    it.each(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'range'])('an input of type %s has no text to undo: the key is ours', (type) => {
      const onUndo = open();
      const box = document.body.appendChild(document.createElement('input'));
      box.type = type;
      press(box);
      box.remove();
      expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it.each(['text', 'search', 'number', 'date', 'email'])('an input of type %s keeps its own Ctrl+Z', (type) => {
      const onUndo = open();
      const field = document.body.appendChild(document.createElement('input'));
      field.type = type;
      press(field);
      field.remove();
      expect(onUndo).not.toHaveBeenCalled();
    });

    it('a key something else already took stays taken: the budget grid has an undo of its own', () => {
      const onUndo = vi.fn();
      render(<><Toaster /><div data-testid="grid" tabIndex={0} onKeyDown={(e) => e.preventDefault()} /></>);
      act(() => { notify.undoable('Transaction allocated', { onUndo }); });
      press(screen.getByTestId('grid'));
      expect(onUndo).not.toHaveBeenCalled();
    });

    it('stands down while any modal is open, with focus outside it', () => {
      const onUndo = open();
      const modal = document.body.appendChild(document.createElement('div'));
      modal.setAttribute('aria-modal', 'true');
      press(document.body);
      modal.remove();
      expect(onUndo).not.toHaveBeenCalled();
    });

    it('a shell that says aria-modal="false", as the closed sidebar does, does not stand it down', () => {
      const onUndo = open();
      const shell = document.body.appendChild(document.createElement('nav'));
      shell.setAttribute('aria-modal', 'false');
      press(document.body);
      shell.remove();
      expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it('a key pressed in a dialog stays there: the undo behind it posts', () => {
      const onUndo = open();
      const dialog = document.body.appendChild(document.createElement('div'));
      dialog.setAttribute('role', 'dialog');
      const button = dialog.appendChild(document.createElement('button'));
      press(button);
      dialog.remove();
      expect(onUndo).not.toHaveBeenCalled();
    });

    it('two on offer: the newest first, then the older', () => {
      const older = open();
      const newer = vi.fn();
      act(() => { notify.undoable('Transaction allocated', { onUndo: newer }); });
      press(document.body);
      expect(newer).toHaveBeenCalledTimes(1);
      expect(older).not.toHaveBeenCalled();
      advance(500);
      press(document.body);
      expect(older).toHaveBeenCalledTimes(1);
    });

    it('a double-tap undoes one: the second press inside 500 ms is ignored, and the browser still gets nothing', () => {
      const older = open();
      act(() => { notify.undoable('Transaction allocated', { onUndo: vi.fn() }); });
      press(document.body);
      advance(499);
      expect(press(document.body), 'still ours, so no browser undo').toBe(false);
      expect(older).not.toHaveBeenCalled();
      advance(1);
      press(document.body);
      expect(older).toHaveBeenCalledTimes(1);
    });

    it('a toast that timed out is no longer on offer, during its exit or after it', () => {
      const onUndo = open();
      advance(8000);
      press(document.body);
      waitOut(0);
      press(document.body);
      expect(onUndo).not.toHaveBeenCalled();
    });
  });
});
