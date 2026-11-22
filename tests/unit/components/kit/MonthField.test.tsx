import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { MonthField, type MonthFieldProps } from '@/components/ui/MonthField';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const NOW = (): Date => new Date('2026-11-22T10:00:00Z'); // Nov 2026 SAST

function Harness(props: Partial<MonthFieldProps> & { initial?: string | null; spy?: MonthFieldProps['onChange'] }) {
  const { initial = null, spy, ...rest } = props;
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <MonthField label="Period" value={value} getToday={NOW} onChange={(v, validity) => { spy?.(v, validity); setValue(v); }} {...rest} />
      <output data-testid="out">{value ?? 'null'}</output>
    </>
  );
}
const input = () => screen.getByRole('textbox', { name: 'Period' }) as HTMLInputElement;
const openBtn = () => screen.getByRole('button', { name: /choose month/i });
const popup = () => screen.queryByRole('dialog', { name: /choose month/i });
const out = () => screen.getByTestId('out').textContent;
const cell = (ym: string) => screen.getByRole('grid').querySelector<HTMLElement>(`[data-ym="${ym}"]`)!;
const type = (text: string) => { fireEvent.focus(input()); fireEvent.change(input(), { target: { value: text } }); fireEvent.blur(input()); };
const stubMedia = (matches: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches, media: q, addEventListener() {}, removeEventListener() {} }));

describe('MonthField typing', () => {
  it('shows the month as "Mar 2026" and hands the parent YYYY-MM', () => {
    render(<Harness initial="2026-03" />);
    expect(input().value).toBe('Mar 2026');
    type('nov 2025');
    expect(out()).toBe('2025-11');
    expect(input().value).toBe('Nov 2025');
  });
  it('accepts the short forms', () => {
    render(<Harness />);
    type('3'); expect(out()).toBe('2026-03');
    type('t'); expect(out()).toBe('2026-11');
    type('-1'); expect(out()).toBe('2026-10');
    type('12/2024'); expect(out()).toBe('2024-12');
  });
  it('refuses unreadable text: shows why, reports null + invalid, keeps the text', () => {
    const spy = vi.fn(); render(<Harness spy={spy} />);
    type('abc');
    expect(screen.getByRole('alert').textContent).toMatch(/not a month/);
    expect(spy).toHaveBeenLastCalledWith(null, expect.objectContaining({ valid: false, code: 'unreadable' }));
    expect(input().value).toBe('abc');
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });
  it('refuses a month before min / after max with its own message', () => {
    const spy = vi.fn(); render(<Harness spy={spy} minMonth="2026-03" maxMonth="2026-09" />);
    type('2/2026');
    expect(spy).toHaveBeenLastCalledWith(null, expect.objectContaining({ valid: false, code: 'before-min' }));
    type('10/2026');
    expect(spy).toHaveBeenLastCalledWith(null, expect.objectContaining({ valid: false, code: 'after-max' }));
    type('5/2026'); expect(out()).toBe('2026-05');
  });
  it('required: empty is refused; optional: empty is a valid null', () => {
    const spy = vi.fn(); const { unmount } = render(<Harness initial="2026-03" required spy={spy} />);
    type(''); expect(spy).toHaveBeenLastCalledWith(null, expect.objectContaining({ valid: false, code: 'empty' }));
    unmount();
    const spy2 = vi.fn(); render(<Harness initial="2026-03" spy={spy2} />);
    type(''); expect(spy2).toHaveBeenLastCalledWith(null, expect.objectContaining({ valid: true }));
  });
  it('ArrowUp / ArrowDown move one month; Alt+ArrowDown opens instead', () => {
    render(<Harness initial="2026-03" />);
    input().focus();
    fireEvent.keyDown(input(), { key: 'ArrowUp' }); expect(out()).toBe('2026-04');
    fireEvent.keyDown(input(), { key: 'ArrowDown' }); expect(out()).toBe('2026-03');
    expect(popup()).toBeNull();
    fireEvent.keyDown(input(), { key: 'ArrowDown', altKey: true });
    expect(popup()).not.toBeNull(); expect(out()).toBe('2026-03');
  });
  it('a hidden input carries the value for a native form post', () => {
    const { container } = render(<Harness initial="2026-03" name="period" />);
    expect(container.querySelector<HTMLInputElement>('input[type="hidden"][name="period"]')?.value).toBe('2026-03');
  });
});

describe('MonthField popup', () => {
  it('opens only from the button or Alt+ArrowDown, never on focus, click or typing', () => {
    render(<Harness />);
    fireEvent.focus(input()); fireEvent.click(input()); fireEvent.change(input(), { target: { value: 'ma' } });
    expect(popup()).toBeNull();
    expect(openBtn().getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(openBtn());
    expect(popup()).not.toBeNull();
    expect(openBtn().getAttribute('aria-expanded')).toBe('true');
  });
  it('opens on the field month, else this month, and marks selected / current', () => {
    const { unmount } = render(<Harness initial="2026-03" />);
    fireEvent.click(openBtn());
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('2026');
    expect(cell('2026-03').getAttribute('aria-selected')).toBe('true');
    expect(cell('2026-11').getAttribute('aria-current')).toBe('date');
    unmount();
    render(<Harness />);
    fireEvent.click(openBtn());
    expect(document.activeElement).toBe(cell('2026-11'));
  });
  it('picking a month with the mouse commits it, closes, and returns focus to the text box', () => {
    render(<Harness initial="2026-03" />);
    fireEvent.click(openBtn());
    fireEvent.click(cell('2026-07'));
    expect(out()).toBe('2026-07'); expect(input().value).toBe('Jul 2026');
    expect(popup()).toBeNull(); expect(document.activeElement).toBe(input());
  });
  it('year buttons change the year shown; the month under focus is kept', () => {
    render(<Harness initial="2026-03" />);
    fireEvent.click(openBtn());
    fireEvent.click(screen.getByRole('button', { name: 'Next year' }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('2027');
    fireEvent.click(screen.getByRole('button', { name: 'Previous year' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous year' }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('2025');
    fireEvent.click(cell('2025-03'));
    expect(out()).toBe('2025-03');
  });
  it('keyboard: arrows move by month and by row, PageUp/PageDown by year, Home/End to the row ends, Enter picks', () => {
    render(<Harness initial="2026-05" />);
    fireEvent.click(openBtn());
    const key = (k: string, extra = {}) => fireEvent.keyDown(screen.getByRole('grid'), { key: k, ...extra });
    key('ArrowRight'); expect(document.activeElement).toBe(cell('2026-06'));
    key('ArrowDown'); expect(document.activeElement).toBe(cell('2026-09'));
    key('ArrowLeft'); expect(document.activeElement).toBe(cell('2026-08'));
    key('ArrowUp'); expect(document.activeElement).toBe(cell('2026-05'));
    key('PageDown'); expect(document.activeElement).toBe(cell('2027-05'));
    key('PageUp'); key('PageUp'); expect(document.activeElement).toBe(cell('2025-05'));
    key('Home'); expect(document.activeElement).toBe(cell('2025-04'));
    key('End'); expect(document.activeElement).toBe(cell('2025-06'));
    key('ArrowRight'); expect(document.activeElement).toBe(cell('2025-07'));
    key('Enter');
    expect(out()).toBe('2025-07'); expect(popup()).toBeNull();
  });
  it('arrow past December rolls into the next year', () => {
    render(<Harness initial="2026-12" />);
    fireEvent.click(openBtn());
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('2027');
    expect(document.activeElement).toBe(cell('2027-01'));
  });
  it('Escape closes without changing the value and returns focus to the button (the box when Alt+ArrowDown opened it)', () => {
    const { unmount } = render(<Harness initial="2026-03" />);
    fireEvent.click(openBtn());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(popup()).toBeNull(); expect(out()).toBe('2026-03'); expect(document.activeElement).toBe(openBtn());
    unmount();
    render(<Harness initial="2026-03" />);
    input().focus();
    fireEvent.keyDown(input(), { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(input());
  });
  it('a press outside closes it; the opener button toggles it', () => {
    render(<Harness />);
    fireEvent.click(openBtn()); expect(popup()).not.toBeNull();
    fireEvent.mouseDown(document.body); expect(popup()).toBeNull();
    fireEvent.click(openBtn()); fireEvent.mouseDown(openBtn()); fireEvent.click(openBtn());
    expect(popup()).toBeNull();
  });
  it('months outside min / max are disabled and cannot be picked', () => {
    render(<Harness initial="2026-05" minMonth="2026-03" maxMonth="2026-09" />);
    fireEvent.click(openBtn());
    expect(cell('2026-02').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-10').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-04').getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(cell('2026-10')); expect(out()).toBe('2026-05');
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'PageDown' });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('2026'); // stops at the bound
  });
  it('the typed month is what the popup opens on', () => {
    render(<Harness initial="2026-03" />);
    fireEvent.focus(input()); fireEvent.change(input(), { target: { value: 'sep 2024' } });
    fireEvent.click(openBtn());
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('2024');
    expect(cell('2024-09').getAttribute('aria-selected')).toBe('true');
  });
  it('is a bottom sheet below lg and a popover from lg up', () => {
    stubMedia(true);
    const { unmount } = render(<Harness />); fireEvent.click(openBtn());
    expect(popup()?.getAttribute('data-layout')).toBe('sheet');
    unmount(); cleanup();
    stubMedia(false);
    render(<Harness />); fireEvent.click(openBtn());
    expect(popup()?.getAttribute('data-layout')).toBe('popover');
  });
  it('This month button picks the current month; a disabled one stays off', () => {
    render(<Harness initial="2026-03" />);
    fireEvent.click(openBtn());
    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    expect(out()).toBe('2026-11');
  });
});

describe('MonthField bounds on the shortcut buttons', () => {
  it('This month is disabled when this month is outside min / max', () => {
    render(<Harness initial="2026-05" maxMonth="2026-09" />);
    fireEvent.click(openBtn());
    expect((screen.getByRole('button', { name: 'This month' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('the popup opens on the nearest allowed month when the field month is out of bounds', () => {
    render(<Harness initial="2026-01" minMonth="2026-03" />);
    fireEvent.click(openBtn());
    expect(document.activeElement).toBe(cell('2026-03'));
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Enter' });
    expect(out()).toBe('2026-03');
  });
});

describe('MonthField review fixes', () => {
  it('clicking a disabled month then pressing Enter picks nothing', () => {
    render(<Harness initial="2026-03" maxMonth="2026-06" />);
    fireEvent.click(openBtn());
    const aug = cell('2026-08');
    fireEvent.focus(aug); fireEvent.click(aug);
    expect(cell('2026-03').tabIndex).toBe(0); // the roving stop did not move onto the disabled month
    expect(aug.tabIndex).toBe(-1);
    // the browser focus on the disabled month was handed straight back to the roving stop
    expect(document.activeElement).toBe(cell('2026-03'));
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Enter' });
    expect(out()).toBe('2026-03'); // Enter picked the month that still has the roving stop, never August
  });
  it('ArrowUp / ArrowDown stay inside min / max, and an empty box starts from the nearest allowed month', () => {
    const { unmount } = render(<Harness initial="2026-06" maxMonth="2026-06" minMonth="2026-01" />);
    input().focus();
    fireEvent.keyDown(input(), { key: 'ArrowUp' }); expect(out()).toBe('2026-06');
    unmount();
    render(<Harness maxMonth="2026-06" />); // this month (Nov 2026) is past the max
    input().focus();
    fireEvent.keyDown(input(), { key: 'ArrowUp' }); expect(out()).toBe('2026-06');
  });
  it('a different value from the parent replaces refused text on screen', () => {
    const { rerender } = render(<MonthField label="Period" value="2026-03" getToday={NOW} onChange={() => {}} />);
    type('abc');
    expect(input().value).toBe('abc');
    rerender(<MonthField label="Period" value="2026-07" getToday={NOW} onChange={() => {}} />);
    expect(input().value).toBe('Jul 2026');
  });
  it('requiredMark={false} keeps the box required but drops the asterisk', () => {
    render(<MonthField label="Month" required requiredMark={false} value="2026-03" getToday={NOW} onChange={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Month' }).getAttribute('aria-required')).toBe('true');
    expect(screen.getByText('Month').textContent).toBe('Month');
  });
  it('a hidden label is still the accessible name and leaves no gap row', () => {
    render(<MonthField label="Period" labelHidden value={null} getToday={NOW} onChange={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Period' })).toBeTruthy();
    expect(screen.getByText('Period').closest('div')?.className).toContain('sr-only');
  });
});

describe('MonthField accessibility (axe)', () => {
  it('has no violations closed or open', async () => {
    const run = async (ctx: Element | Document) => (await axe.run(ctx as Element, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations;
    render(<Harness initial="2026-03" />);
    expect((await run(document.body)).map(v => v.id)).toEqual([]);
    fireEvent.click(openBtn());
    expect((await run(document.body)).map(v => v.id)).toEqual([]);
  });
});
