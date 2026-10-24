import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MoneyField, type MoneyFieldProps } from '@/components/ui/MoneyField';

const plain = (s: string | null | undefined): string => (s ?? '').replace(/ /g, ' ');

function Harness(props: Partial<MoneyFieldProps> & { initial?: number | null; spy?: (v: number | null) => void }) {
  const { initial = null, spy, ...rest } = props;
  const [value, setValue] = useState<number | null>(initial);
  return (
    <>
      <MoneyField
        label="Amount"
        value={value}
        onChange={(v) => {
          spy?.(v);
          setValue(v);
        }}
        {...rest}
      />
      <output data-testid="out">{value === null ? 'null' : String(value)}</output>
    </>
  );
}

const input = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement;
const type = (text: string): void => {
  fireEvent.change(input(), { target: { value: text } });
};
const out = (): string => screen.getByTestId('out').textContent ?? '';

describe('MoneyField', () => {
  it('associates the label with the input', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Amount')).toBe(input());
    expect(input().getAttribute('inputmode')).toBe('decimal');
  });

  it.each([
    ['25 000,00', 2_500_000],
    ['25,000.00', 2_500_000],
    ['R 1 234.56', 123_456],
    ['(123.45)', null],
  ])('parses %j on blur', (text, cents) => {
    const spy = vi.fn();
    render(<Harness spy={spy} allowNegative />);
    type(text);
    fireEvent.blur(input());
    expect(out()).toBe(cents === null ? '-12345' : String(cents));
  });

  it('hands the parent nothing until the user commits', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    type('25 000,00');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(spy).toHaveBeenCalledExactlyOnceWith(2_500_000);
  });

  it('commits on Enter', () => {
    render(<Harness />);
    type('12,50');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(out()).toBe('1250');
  });

  it('echoes what it understood, live while typing and after blur', () => {
    render(<Harness />);
    type('25 000,00');
    expect(plain(screen.getByText(/^R 25 000\.00$/u).textContent)).toBe('R 25 000.00');
    fireEvent.blur(input());
    expect(plain(screen.getByText(/^R 25 000\.00$/u).textContent)).toBe('R 25 000.00');
    expect(plain(input().value)).toBe('25 000.00');
  });

  it('points aria-describedby at the echo', () => {
    render(<Harness />);
    type('1234.5');
    const echo = screen.getByText(/R 1.234\.50/u);
    expect(input().getAttribute('aria-describedby')).toBe(echo.id);
    expect(echo.getAttribute('aria-live')).toBe('polite');
  });

  it('refuses an ambiguous amount: error text, aria-invalid, describedby, no echo, null out', () => {
    render(<Harness initial={500} />);
    type('1,234');
    fireEvent.blur(input());
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/ambiguous/);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toBe(alert.id);
    expect(input().value).toBe('1,234');
    expect(out()).toBe('null');
    expect(screen.queryByText(/^R /u)).toBeNull();
  });

  it('clears the error as soon as the user types again', () => {
    render(<Harness />);
    type('1,234');
    fireEvent.blur(input());
    expect(screen.getByRole('alert')).toBeTruthy();
    type('1 234');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input().getAttribute('aria-invalid')).toBe('false');
  });

  it('refuses a negative amount unless allowNegative', () => {
    const { unmount } = render(<Harness />);
    type('-5');
    expect(screen.queryByText(/^-R /u)).toBeNull();
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toMatch(/negative/i);
    expect(out()).toBe('null');
    unmount();
    render(<Harness allowNegative />);
    type('-5');
    fireEvent.blur(input());
    expect(out()).toBe('-500');
    expect(screen.getByText(/^-R 5\.00$/u)).toBeTruthy();
  });

  it('enforces min and max in cents', () => {
    render(<Harness min={1_000} max={5_000} />);
    type('5');
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toMatch(/at least R 10\.00/);
    type('60');
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toMatch(/at most R 50\.00/);
    type('25');
    fireEvent.blur(input());
    expect(out()).toBe('2500');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an external error instead of its own', () => {
    render(<Harness error="Exceeds the credit limit." />);
    expect(screen.getByRole('alert').textContent).toBe('Exceeds the credit limit.');
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('empty is null; required empty is an error', () => {
    const { unmount } = render(<Harness initial={500} />);
    type('');
    fireEvent.blur(input());
    expect(out()).toBe('null');
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    render(<Harness required />);
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toBe('Enter an amount.');
    expect(input().getAttribute('aria-required')).toBe('true');
  });

  it('shows the currency badge and echoes a non-ZAR currency with its code', () => {
    render(<Harness currency="USD" />);
    expect(screen.getByText('USD')).toBeTruthy();
    type('25,000.00');
    expect(plain(screen.getByText(/^USD 25 000\.00$/u).textContent)).toBe('USD 25 000.00');
  });

  it('follows an outside change to value', () => {
    const { rerender } = render(<MoneyField label="Amount" value={100} onChange={() => undefined} />);
    expect(input().value).toBe('1.00');
    rerender(<MoneyField label="Amount" value={250_000} onChange={() => undefined} />);
    expect(plain(input().value)).toBe('2 500.00');
  });

  it('keeps unreadable text on screen after it reports null', () => {
    render(<Harness initial={500} />);
    type('abc');
    fireEvent.blur(input());
    expect(out()).toBe('null');
    expect(input().value).toBe('abc');
  });
});
