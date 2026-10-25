import { describe, it, expect, vi, afterAll } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateField, type DateFieldProps } from '@/components/ui/DateField';
import { formatDisplayDate } from '@/utils/dateFormat';

// What the field shows is the canonical formatter's output (ICU decides "01" vs "1"), never its own.
const shown = (y: number, m: number, d: number): string => formatDisplayDate(new Date(y, m - 1, d));

// The field must not depend on the device's zone.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// 23:59:30 SAST on Thursday 15 Oct 2026 (21:59:30Z). The device zone below is Los Angeles on purpose.
const TODAY = (): Date => new Date('2026-10-15T21:59:30Z');

function Harness(props: Partial<DateFieldProps> & { initial?: string | null; spy?: DateFieldProps['onChange'] }) {
  const { initial = null, spy, ...rest } = props;
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <DateField
        label="Invoice date"
        value={value}
        getToday={TODAY}
        onChange={(v, validity) => {
          spy?.(v, validity);
          setValue(v);
        }}
        {...rest}
      />
      <output data-testid="out">{value ?? 'null'}</output>
    </>
  );
}

const input = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Invoice date' }) as HTMLInputElement;
const type = (text: string): void => {
  fireEvent.change(input(), { target: { value: text } });
};
const commit = (text: string): void => {
  type(text);
  fireEvent.blur(input());
};
const out = (): string => screen.getByTestId('out').textContent ?? '';

describe('DateField', () => {
  it('associates the label with the input, and is a text input (not type=date)', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Invoice date')).toBe(input());
    expect(input().type).toBe('text');
  });

  it('displays the canonical short date and emits ISO', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    commit('1 Oct 2026');
    expect(input().value).toBe(shown(2026, 10, 1));
    expect(spy).toHaveBeenCalledExactlyOnceWith('2026-10-01', { valid: true, reason: null });
    expect(out()).toBe('2026-10-01');
  });

  it.each([
    ['2026-10-01', '2026-10-01'],
    ['01/10/2026', '2026-10-01'],
    ['1 October 2026', '2026-10-01'],
    ['t', '2026-10-15'],
    ['+30', '2026-11-14'],
    ['-7', '2026-10-08'],
    ['eom', '2026-10-31'],
  ])('accepts %j', (text, iso) => {
    render(<Harness />);
    commit(text);
    expect(out()).toBe(iso);
  });

  it('commits on Enter', () => {
    render(<Harness />);
    type('+1');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(out()).toBe('2026-10-16');
    expect(input().value).toBe(shown(2026, 10, 16));
  });

  it('echoes the understood date with its weekday, live while typing', () => {
    render(<Harness />);
    type('+30');
    const echo = screen.getByText('Saturday, 14 November 2026');
    expect(input().getAttribute('aria-describedby')).toBe(echo.id);
    expect(input().value).toBe('+30');
  });

  it('refuses an impossible date with a reason and emits null', () => {
    render(<Harness initial="2026-10-01" />);
    commit('31/02/2026');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/not a real calendar date/);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toBe(alert.id);
    expect(input().value).toBe('31/02/2026');
    expect(out()).toBe('null');
  });

  it('refuses text that is not a date', () => {
    render(<Harness />);
    commit('soon');
    expect(screen.getByRole('alert').textContent).toMatch(/not a date/);
  });

  it('enforces minDate with a default message naming the date', () => {
    render(<Harness minDate="2026-03-01" />);
    commit('28/02/2026');
    expect(screen.getByRole('alert').textContent).toBe(`The date must be on or after ${shown(2026, 3, 1)}.`);
    expect(out()).toBe('null');
    commit('01/03/2026');
    expect(out()).toBe('2026-03-01');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('enforces maxDate and uses a custom message (lock date)', () => {
    render(<Harness maxDate="2027-02-28" maxMessage="That period is locked." />);
    commit('2027-03-01');
    expect(screen.getByRole('alert').textContent).toBe('That period is locked.');
    commit('2027-02-28');
    expect(out()).toBe('2027-02-28');
  });

  it('applies the bounds to shortcuts too', () => {
    render(<Harness maxDate="2026-10-31" />);
    commit('+30');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(out()).toBe('null');
  });

  it('ArrowUp and ArrowDown move the date by one day', () => {
    render(<Harness initial="2026-10-31" />);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(out()).toBe('2026-11-01');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(out()).toBe('2026-10-30');
  });

  it('ArrowUp on an empty field starts from today', () => {
    render(<Harness />);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(out()).toBe('2026-10-15');
  });

  it('empty is null; required empty is an error', () => {
    const { unmount } = render(<Harness initial="2026-10-01" />);
    commit('');
    expect(out()).toBe('null');
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    render(<Harness required />);
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toBe('Enter a date.');
  });

  it('shows an external error', () => {
    render(<Harness error="Date is in a closed period." />);
    expect(screen.getByRole('alert').textContent).toBe('Date is in a closed period.');
  });

  it('follows an outside change to value', () => {
    const { rerender } = render(
      <DateField label="Invoice date" value="2026-10-01" onChange={() => undefined} />,
    );
    expect(input().value).toBe(shown(2026, 10, 1));
    rerender(<DateField label="Invoice date" value="2026-12-25" onChange={() => undefined} />);
    expect(input().value).toBe(shown(2026, 12, 25));
  });

  it('reports a refusal even when the value stays null', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    commit('31/02/2026');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBeNull();
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ valid: false });
    commit('1 Oct 2026');
    expect(spy).toHaveBeenLastCalledWith('2026-10-01', { valid: true, reason: null });
  });

  it('an out-of-range date is a refusal too, so the form can block submit', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} maxDate="2026-12-31" />);
    commit('1 Jan 2027');
    expect(spy).toHaveBeenLastCalledWith(null, { valid: false, reason: `The date must be on or before ${shown(2026, 12, 31)}.` });
  });

  it('minDate and maxDate are inclusive', () => {
    render(<Harness minDate="2026-03-01" maxDate="2026-03-31" />);
    commit('1 Mar 2026');
    expect(out()).toBe('2026-03-01');
    commit('31 Mar 2026');
    expect(out()).toBe('2026-03-31');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ArrowUp / ArrowDown leave unreadable text alone and do not swallow the key', () => {
    render(<Harness />);
    type('soon');
    const notPrevented = fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(notPrevented).toBe(true);
    expect(input().value).toBe('soon');
    expect(out()).toBe('null');
  });

  it('ArrowUp on an empty field starts from the SAST day', () => {
    render(<Harness />);
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(out()).toBe('2026-10-15');
  });

  it('throws a RangeError for a bound that is not a real YYYY-MM-DD', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const props of [{ minDate: '2026-3-1' }, { maxDate: '31/03/2026' }, { minDate: '2026-02-30' }]) {
      expect(() => render(<DateField label="D" value={null} onChange={() => undefined} {...props} />)).toThrow(RangeError);
    }
    quiet.mockRestore();
  });

  it('posts the canonical ISO date through a hidden input, never the display text', () => {
    const { container } = render(<Harness name="due" initial="2026-10-01" />);
    const hidden = container.querySelector('input[type="hidden"][name="due"]') as HTMLInputElement;
    expect(hidden.value).toBe('2026-10-01');
    expect(input().getAttribute('name')).toBeNull();
    commit('+30');
    expect(hidden.value).toBe('2026-11-14');
    commit('soon');
    expect(hidden.value).toBe('');
  });

  it('passes onBlur through', () => {
    const onBlur = vi.fn();
    render(<Harness onBlur={onBlur} />);
    commit('t');
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('the echo is the canonical weekday form', () => {
    render(<Harness />);
    type('1 Oct 2026');
    expect(screen.getByText('Thursday, 1 October 2026')).toBeTruthy();
  });

  it('a form reset clears refused text via resetKey', () => {
    const { rerender } = render(<DateField label="Invoice date" value={null} onChange={() => undefined} resetKey={0} />);
    commit('soon');
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<DateField label="Invoice date" value={null} onChange={() => undefined} resetKey={1} />);
    expect(input().value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
