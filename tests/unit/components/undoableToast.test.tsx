/**
 * Master plan U (M9): notify.undoable. The real notify over the real Toaster: the button is a real button that
 * Tab reaches, the toast announces politely, the undo runs once however often it is clicked, the toast stays up
 * while it is hovered or focused, and it goes on its own after durationMs.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import toast, { Toaster } from 'react-hot-toast';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notify } from '@/utils/toast';

const REMOVE_DELAY = 1100; // react-hot-toast keeps a dismissed toast mounted for 1 s

function open(onUndo = vi.fn(), opts: { durationMs?: number; message?: string } = {}) {
  render(<Toaster />);
  act(() => { notify.undoable('Transaction excluded', { onUndo, ...opts }); });
  return onUndo;
}
const undo = () => screen.getByRole('button', { name: 'Undo' });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  act(() => { toast.remove(); });
  cleanup();
  vi.useRealTimers();
});

describe('notify.undoable', () => {
  it('announces politely, in a status region that holds the title and the message', () => {
    open(vi.fn(), { message: 'What was learned is kept.' });
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Transaction excluded');
    expect(region.textContent).toContain('What was learned is kept.');
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
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismisses itself after 8 seconds by default, and not before', () => {
    open();
    advance(7900);
    expect(screen.getByRole('status')).toBeTruthy();
    advance(100);
    advance(REMOVE_DELAY);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('honours durationMs', () => {
    open(vi.fn(), { durationMs: 2000 });
    advance(2000);
    advance(REMOVE_DELAY);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('pauses while hovered and carries on with the time that was left', () => {
    open();
    advance(5000);
    fireEvent.mouseEnter(screen.getByRole('status'));
    advance(60_000);
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.mouseLeave(screen.getByRole('status'));
    advance(2900);
    expect(screen.getByRole('status')).toBeTruthy();
    advance(100);
    advance(REMOVE_DELAY);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('pauses while focus is inside it', () => {
    open();
    fireEvent.focus(undo());
    advance(60_000);
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.blur(undo());
    advance(8000);
    advance(REMOVE_DELAY);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays paused when the pointer leaves while the button still has focus', () => {
    open();
    fireEvent.mouseEnter(screen.getByRole('status'));
    fireEvent.focus(undo());
    fireEvent.mouseLeave(screen.getByRole('status'));
    advance(60_000);
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
