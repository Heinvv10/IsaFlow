/** Save bar (spec §5.6, §6.4): count, Save, a confirmed Discard, inline save errors, hidden when read-only. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveBar, type SaveBarProps } from '@/components/accounting/budgets/workspace/SaveBar';

afterEach(cleanup);

const props = (over: Partial<SaveBarProps> = {}): SaveBarProps => ({
  dirtyCount: 3, saveState: { status: 'idle' }, readOnly: false, onSave: vi.fn(), onDiscard: vi.fn(), ...over,
});

describe('SaveBar', () => {
  it('Discard asks first: "Keep editing" discards nothing, the confirm discards once', () => {
    const p = props();
    render(<SaveBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog = screen.getByTestId('discard-dialog');
    expect(dialog).toHaveTextContent('Discard 3 unsaved changes?');
    expect(p.onDiscard).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByTestId('discard-dialog')).toBeNull();
    expect(p.onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(within(screen.getByTestId('discard-dialog')).getByRole('button', { name: 'Discard' }));
    expect(p.onDiscard).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('discard-dialog')).toBeNull();
  });

  it('Escape on the confirm keeps the changes', () => {
    const p = props();
    render(<SaveBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('discard-dialog')).toBeNull();
    expect(p.onDiscard).not.toHaveBeenCalled();
  });

  it('Save calls back; saving disables both buttons and says so', () => {
    const p = props();
    const { rerender } = render(<SaveBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(p.onSave).toHaveBeenCalledTimes(1);
    rerender(<SaveBar {...p} saveState={{ status: 'saving' }} />);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });

  it('a failed save is an alert with the retry time; the count stays', () => {
    render(<SaveBar {...props({ saveState: { status: 'error', message: 'Too many saves.', retryAfter: 12 } })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Too many saves. Try again in 12 s.');
    expect(screen.getByTestId('save-bar-count')).toHaveTextContent('3 unsaved changes');
  });

  it('read-only (locked or no write role) renders no bar; clean and idle renders none', () => {
    const { rerender } = render(<SaveBar {...props({ readOnly: true })} />);
    expect(screen.queryByTestId('save-bar')).toBeNull();
    rerender(<SaveBar {...props({ dirtyCount: 0 })} />);
    expect(screen.queryByTestId('save-bar')).toBeNull();
  });

  it('stays in view whatever the horizontal scroll: fixed to the viewport bottom over the content column, never sticky inside the scrolled page', () => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    main.getBoundingClientRect = () => ({ left: 240, top: 0, right: 1280, bottom: 800, width: 1040, height: 800, x: 240, y: 0, toJSON: () => ({}) });
    Object.defineProperty(main, 'clientWidth', { value: 1025 }); // 15 px vertical scrollbar
    const wide = document.createElement('div'); // the page content, scrolled sideways by the table
    main.appendChild(wide);
    render(<SaveBar {...props()} />, { container: wide });
    const bar = screen.getByTestId('save-bar');
    expect(bar.className).toMatch(/(?<![\w-])fixed(?![\w-])/);
    expect(bar.className).not.toMatch(/(?<![\w-])sticky(?![\w-])/);
    expect(bar.style.bottom).toBe('0px'); // <main> reaches the viewport bottom, no horizontal scrollbar
    expect(bar.style.left).toBe('240px');
    expect(bar.style.width).toBe('1025px');
    // The in-flow spacer keeps the last grid rows from hiding under the bar.
    expect(screen.getByTestId('save-bar-spacer')).toBeInTheDocument();
    main.remove();
  });

  it('the spacer follows the bar\'s real height (it wraps on errors) and the bar sits above <main>\'s horizontal scrollbar', () => {
    const observed: Array<{ cb: () => void; els: Element[] }> = [];
    vi.stubGlobal('ResizeObserver', class {
      private entry: { cb: () => void; els: Element[] };
      constructor(cb: () => void) { this.entry = { cb, els: [] }; observed.push(this.entry); }
      observe(el: Element) { this.entry.els.push(el); }
      disconnect() { this.entry.els = []; }
    });
    const main = document.createElement('main');
    document.body.appendChild(main);
    // <main> ends 40 px above the viewport bottom and has a 15 px horizontal scrollbar.
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    main.getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 760, width: 390, height: 760, x: 0, y: 0, toJSON: () => ({}) });
    Object.defineProperty(main, 'clientWidth', { value: 390 });
    Object.defineProperty(main, 'offsetHeight', { value: 760 });
    Object.defineProperty(main, 'clientHeight', { value: 745 });
    render(<SaveBar {...props()} />, { container: main.appendChild(document.createElement('div')) });
    const bar = screen.getByTestId('save-bar');
    const spacer = screen.getByTestId('save-bar-spacer');
    expect(bar.style.bottom).toBe('55px');
    let height = 56;
    Object.defineProperty(bar, 'offsetHeight', { get: () => height });
    act(() => { for (const o of observed) if (o.els.includes(bar)) o.cb(); });
    expect(spacer.style.height).toBe('56px');
    height = 104; // wrapped onto two lines
    act(() => { for (const o of observed) if (o.els.includes(bar)) o.cb(); });
    expect(spacer.style.height).toBe('104px');
    main.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
