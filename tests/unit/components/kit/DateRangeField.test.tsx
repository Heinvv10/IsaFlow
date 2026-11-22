import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CompanyContext } from '@/contexts/CompanyContext';
import { DateRangeField, type DateRange } from '@/components/ui/DateRangeField';

const NOW = () => new Date('2026-11-22T10:00:00Z'); // 22 Nov 2026 SAST

function Harness({ initial = { from: null, to: null }, fy = 3, spy }: { initial?: DateRange; fy?: number; spy?: (r: DateRange) => void }) {
  const [v, setV] = useState<DateRange>(initial);
  return <DateRangeField label="Period" value={v} fyStartMonth={fy} getToday={NOW} onChange={r => { spy?.(r); setV(r); }} />;
}
const preset = (name: string) => screen.getByRole('button', { name });
const typeInto = (label: string, text: string) => {
  const el = screen.getByLabelText(new RegExp(label)) as HTMLInputElement;
  fireEvent.focus(el); fireEvent.change(el, { target: { value: text } }); fireEvent.blur(el);
};

describe('DateRangeField', () => {
  it('a preset fills both ends from the company financial year', () => {
    const spy = vi.fn(); render(<Harness spy={spy} />);
    fireEvent.click(preset('Last financial year'));
    expect(spy).toHaveBeenLastCalledWith({ from: '2025-03-01', to: '2026-02-28' });
    fireEvent.click(preset('This quarter'));
    expect(spy).toHaveBeenLastCalledWith({ from: '2026-09-01', to: '2026-11-30' });
  });
  it('uses the financial-year month it is given (January = calendar year)', () => {
    const spy = vi.fn(); render(<Harness spy={spy} fy={1} />);
    fireEvent.click(preset('This financial year'));
    expect(spy).toHaveBeenLastCalledWith({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('marks the preset the range equals, and Custom once it differs', () => {
    render(<Harness initial={{ from: '2026-11-01', to: '2026-11-30' }} />);
    expect(preset('This month').getAttribute('aria-pressed')).toBe('true');
    typeInto('From', '2 Nov 2026');
    expect(preset('This month').getAttribute('aria-pressed')).toBe('false');
    expect(preset('Custom').getAttribute('aria-pressed')).toBe('true');
  });
  it('typing both dates works with the same shortcuts as DateField', () => {
    const spy = vi.fn(); render(<Harness spy={spy} />);
    typeInto('From', '1/10/2026'); typeInto('To', '31/10/2026');
    expect(spy).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-31' });
  });
  it('refuses a To before From', () => {
    const spy = vi.fn(); render(<Harness initial={{ from: '2026-10-10', to: null }} spy={spy} />);
    typeInto('To', '1 Oct 2026');
    expect(screen.getByRole('alert').textContent).toMatch(/before/i);
    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ to: '2026-10-01' }));
  });
  it('moving From past To pushes To along instead of leaving an inverted range', () => {
    const spy = vi.fn(); render(<Harness initial={{ from: '2026-10-01', to: '2026-10-31' }} spy={spy} />);
    typeInto('From', '15 Nov 2026');
    const last = spy.mock.calls.at(-1)![0] as DateRange;
    expect(last.from).toBe('2026-11-15');
    expect(last.to === null || last.to >= last.from).toBe(true);
  });
  it('the Custom pill selects Custom without touching the dates', () => {
    const spy = vi.fn(); render(<Harness initial={{ from: '2026-11-01', to: '2026-11-30' }} spy={spy} />);
    fireEvent.click(preset('Custom'));
    expect(preset('Custom').getAttribute('aria-pressed')).toBe('true');
    expect(preset('This month').getAttribute('aria-pressed')).toBe('false');
    expect(spy).not.toHaveBeenCalled();
  });
  it('takes the financial year from the active company when no month is passed', () => {
    const spy = vi.fn();
    const ctx = { activeCompany: { financialYearStart: 1 } } as never;
    render(<CompanyContext.Provider value={ctx}><DateRangeField label="Period" value={{ from: null, to: null }} getToday={NOW} onChange={spy} /></CompanyContext.Provider>);
    fireEvent.click(preset('This financial year'));
    expect(spy).toHaveBeenLastCalledWith({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('shows the preset buttons as a labelled group', () => {
    render(<Harness />);
    expect(screen.getByRole('group', { name: /period presets|Period/ })).toBeTruthy();
    act(() => {});
  });
});
