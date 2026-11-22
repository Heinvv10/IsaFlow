import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { DateField, type DateFieldProps } from '@/components/ui/DateField';

afterEach(cleanup);

const TODAY = (): Date => new Date('2026-10-15T08:00:00Z'); // Thursday 15 Oct 2026 SAST

function Harness(props: Partial<DateFieldProps> & { initial?: string | null }) {
  const { initial = null, ...rest } = props;
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <DateField label="Invoice date" value={value} getToday={TODAY} onChange={(v) => setValue(v)} {...rest} />
      <button type="button">after</button>
      <output data-testid="out">{value ?? 'null'}</output>
    </>
  );
}
const input = () => screen.getByRole('textbox', { name: 'Invoice date' }) as HTMLInputElement;
const openBtn = () => screen.getByRole('button', { name: /choose date/i });
const popup = () => screen.queryByRole('dialog', { name: /choose date/i });
const out = () => screen.getByTestId('out').textContent;
const cell = (iso: string) => screen.getByRole('grid').querySelector<HTMLElement>(`[data-iso="${iso}"]`)!;

describe('DateField calendar: opening', () => {
  it('has a calendar button whose name says it opens a picker and names the shortcut', () => {
    render(<Harness />);
    expect(openBtn().getAttribute('aria-haspopup')).toBe('dialog');
    expect(openBtn().getAttribute('aria-expanded')).toBe('false');
    expect(openBtn().getAttribute('type')).toBe('button');
    expect(openBtn().getAttribute('title')).toMatch(/Alt/);
  });
  it('never opens on focus or click of the text box, nor while typing', () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.click(input());
    fireEvent.change(input(), { target: { value: '15/03' } });
    expect(popup()).toBeNull();
  });
  it('opens from the button', () => {
    render(<Harness />);
    fireEvent.click(openBtn());
    expect(popup()).not.toBeNull();
    expect(openBtn().getAttribute('aria-expanded')).toBe('true');
  });
  it('opens on Alt+ArrowDown, and plain ArrowDown still steps the date', () => {
    render(<Harness initial="2026-10-10" />);
    input().focus();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(popup()).toBeNull();
    expect(input().value).toMatch(/09 Oct 2026/);
    fireEvent.keyDown(input(), { key: 'ArrowDown', altKey: true });
    expect(popup()).not.toBeNull();
    expect(input().value).toMatch(/09 Oct 2026/); // the alt press did not also step
  });
  it('does not open when disabled', () => {
    render(<Harness disabled />);
    expect((openBtn() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input(), { key: 'ArrowDown', altKey: true });
    expect(popup()).toBeNull();
  });
  it('opens on the field date, else today', () => {
    const { unmount } = render(<Harness initial="2026-03-15" />);
    fireEvent.click(openBtn());
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/March 2026/);
    expect(cell('2026-03-15').getAttribute('aria-selected')).toBe('true');
    unmount();
    render(<Harness />);
    fireEvent.click(openBtn());
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/October 2026/);
    expect(cell('2026-10-15').getAttribute('aria-current')).toBe('date');
  });
  it('opens on the month of a typed-but-uncommitted readable date', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '15/03/2024' } });
    fireEvent.click(openBtn());
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/March 2024/);
  });
});

describe('DateField calendar: picking and closing', () => {
  it('a click picks the day, commits it (ISO to the parent), closes and returns focus to the text box', () => {
    render(<Harness initial="2026-10-10" />);
    fireEvent.click(openBtn());
    fireEvent.click(cell('2026-10-20'));
    expect(out()).toBe('2026-10-20');
    expect(input().value).toMatch(/20 Oct 2026/);
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(input());
  });
  it('Escape closes without changing the date and returns focus', () => {
    render(<Harness initial="2026-10-10" />);
    fireEvent.click(openBtn());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(popup()).toBeNull();
    expect(out()).toBe('2026-10-10');
  });
  it('the Today button picks today', () => {
    render(<Harness initial="2026-03-01" />);
    fireEvent.click(openBtn());
    fireEvent.click(screen.getByRole('button', { name: /^today$/i }));
    expect(out()).toBe('2026-10-15');
  });
  it('clicking outside closes it', () => {
    render(<Harness />);
    fireEvent.click(openBtn());
    fireEvent.mouseDown(document.body);
    expect(popup()).toBeNull();
  });
  it('pointer down on the calendar button while open toggles it closed (no close-then-reopen)', () => {
    render(<Harness />);
    fireEvent.click(openBtn());
    fireEvent.mouseDown(openBtn());
    fireEvent.click(openBtn());
    expect(popup()).toBeNull();
  });
  it('a pick re-reports to onChange with a valid validity', () => {
    const spy = vi.fn();
    render(<Harness onChange={spy} />);
    fireEvent.click(openBtn());
    fireEvent.click(cell('2026-10-20'));
    expect(spy).toHaveBeenCalledWith('2026-10-20', expect.objectContaining({ valid: true }));
  });
});

describe('DateField calendar: keyboard (W3C date picker dialog)', () => {
  const open = (initial = '2026-10-15') => { render(<Harness initial={initial} />); fireEvent.click(openBtn()); };
  const key = (k: string, extra: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(document.activeElement!, { key: k, ...extra });
  const focusedIso = () => (document.activeElement as HTMLElement).getAttribute('data-iso');

  it('focus lands on the selected day, which is the only tab stop in the grid (roving tabindex)', () => {
    open();
    expect(focusedIso()).toBe('2026-10-15');
    const stops = screen.getByRole('grid').querySelectorAll('[tabindex="0"]');
    expect(stops.length).toBe(1);
  });
  it('arrows, Home, End move focus', () => {
    open();
    key('ArrowRight'); expect(focusedIso()).toBe('2026-10-16');
    key('ArrowDown'); expect(focusedIso()).toBe('2026-10-23');
    key('ArrowLeft'); expect(focusedIso()).toBe('2026-10-22');
    key('ArrowUp'); expect(focusedIso()).toBe('2026-10-15');
    key('Home'); expect(focusedIso()).toBe('2026-10-12');
    key('End'); expect(focusedIso()).toBe('2026-10-18');
  });
  it('PageDown / PageUp change month, Shift+PageDown a year, and the heading follows', () => {
    open();
    key('PageDown');
    expect(focusedIso()).toBe('2026-11-15');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/November 2026/);
    key('PageDown', { shiftKey: true });
    expect(focusedIso()).toBe('2027-11-15');
    key('PageUp');
    expect(focusedIso()).toBe('2027-10-15');
  });
  it('the heading is a polite live region', () => {
    open();
    expect(screen.getByRole('heading', { level: 2 }).getAttribute('aria-live')).toBe('polite');
  });
  it('Enter and Space pick the focused day', () => {
    open();
    key('ArrowRight');
    key('Enter');
    expect(out()).toBe('2026-10-16');
  });
  it('Space picks too', () => {
    open();
    key('ArrowDown');
    key(' ');
    expect(out()).toBe('2026-10-22');
  });
  it('arrow keys inside the popup do not step the underlying date field or bubble to a parent', () => {
    const parentKey = vi.fn();
    render(<div onKeyDown={parentKey}><Harness initial="2026-10-15" /></div>);
    fireEvent.click(openBtn());
    parentKey.mockClear();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(parentKey).not.toHaveBeenCalled();
    expect(input().value).toMatch(/15 Oct 2026/);
  });
  it('Tab stays inside the popup (it is a modal dialog)', () => {
    open();
    expect(popup()!.getAttribute('aria-modal')).toBe('true');
    const dialogButtons = within(popup()!).getAllByRole('button');
    expect(dialogButtons.length).toBeGreaterThan(2);
  });
});

describe('DateField calendar: jumping and bounds', () => {
  it('month and year selects jump straight to Feb 2024', () => {
    render(<Harness initial="2026-10-15" />);
    fireEvent.click(openBtn());
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2024' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2' } });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/February 2024/);
    fireEvent.click(cell('2024-02-10'));
    expect(out()).toBe('2024-02-10');
  });
  it('previous / next month buttons', () => {
    render(<Harness initial="2026-10-15" />);
    fireEvent.click(openBtn());
    fireEvent.click(screen.getByRole('button', { name: /next month/i }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/November 2026/);
    fireEvent.click(screen.getByRole('button', { name: /previous month/i }));
    fireEvent.click(screen.getByRole('button', { name: /previous month/i }));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/September 2026/);
  });
  it('days outside minDate / maxDate are disabled and cannot be picked', () => {
    render(<Harness initial="2026-10-15" minDate="2026-10-10" maxDate="2026-10-20" />);
    fireEvent.click(openBtn());
    expect(cell('2026-10-09').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-10-21').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-10-10').getAttribute('aria-disabled')).toBeNull();
    expect(cell('2026-10-20').getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(cell('2026-10-09'));
    expect(out()).toBe('2026-10-15');
    expect(popup()).not.toBeNull();
  });
  it('keyboard movement does not leave the allowed range', () => {
    render(<Harness initial="2026-10-15" minDate="2026-10-14" maxDate="2026-10-16" />);
    fireEvent.click(openBtn());
    const k = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    k('ArrowRight'); k('ArrowRight'); k('ArrowRight');
    expect((document.activeElement as HTMLElement).getAttribute('data-iso')).toBe('2026-10-16');
    k('PageDown');
    expect((document.activeElement as HTMLElement).getAttribute('data-iso')).toBe('2026-10-16');
  });
  it('the year select covers minDate..maxDate when both are given', () => {
    render(<Harness initial="2026-10-15" minDate="2024-01-01" maxDate="2027-12-31" />);
    fireEvent.click(openBtn());
    const years = Array.from((screen.getByLabelText('Year') as HTMLSelectElement).options).map((o) => o.value);
    expect(years[0]).toBe('2024');
    expect(years[years.length - 1]).toBe('2027');
  });
  it('shows the shortcut hint in the popup', () => {
    render(<Harness />);
    fireEvent.click(openBtn());
    expect(popup()!.textContent).toMatch(/15\/3/);
    expect(popup()!.textContent).toMatch(/eom/);
  });
});

describe('DateField calendar: phone bottom sheet', () => {
  it('uses the sheet layout below lg and the popover at lg and up', () => {
    const mm = (matches: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
    mm(true);
    const a = render(<Harness />);
    fireEvent.click(openBtn());
    expect(popup()!.getAttribute('data-layout')).toBe('sheet');
    a.unmount();
    mm(false);
    render(<Harness />);
    fireEvent.click(openBtn());
    expect(popup()!.getAttribute('data-layout')).toBe('popover');
    vi.unstubAllGlobals();
  });
  it('every day button is at least 44px on the sheet via its class (touch target)', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
    render(<Harness />);
    fireEvent.click(openBtn());
    expect(cell('2026-10-15').className).toMatch(/min-h-11/);
    vi.unstubAllGlobals();
  });
});

describe('DateField calendar: accessibility (axe)', () => {
  it('has no axe violations closed or open', async () => {
    const { container } = render(<Harness initial="2026-10-15" />);
    const run = async (ctx: Element | Document) => (await axe.run(ctx as Element, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations;
    expect(await run(container)).toEqual([]);
    fireEvent.click(openBtn());
    await act(async () => {});
    expect((await run(document.body)).map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(' | ')}`)).toEqual([]);
  });
  it('every day has a full spoken name (weekday, day, month, year)', () => {
    render(<Harness initial="2026-10-15" />);
    fireEvent.click(openBtn());
    expect(cell('2026-10-15').getAttribute('aria-label')).toMatch(/Thursday.*15.*October.*2026/);
  });
});

describe('DateField calendar: Today outside the allowed range', () => {
  it('disables the Today button', () => {
    render(<Harness initial={null} minDate="2026-12-01" />);
    fireEvent.click(openBtn());
    expect((screen.getByRole('button', { name: /^today$/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
