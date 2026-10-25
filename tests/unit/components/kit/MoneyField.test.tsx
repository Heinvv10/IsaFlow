import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MoneyField, type MoneyFieldProps } from '@/components/ui/MoneyField';

function Harness(props: Partial<MoneyFieldProps> & { initial?: number | null; spy?: MoneyFieldProps['onChange'] }) {
  const { initial = null, spy, ...rest } = props;
  const [value, setValue] = useState<number | null>(initial);
  return (
    <>
      <MoneyField
        label="Amount"
        value={value}
        onChange={(v, validity) => {
          spy?.(v, validity);
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
    expect(spy).toHaveBeenCalledExactlyOnceWith(2_500_000, { valid: true, reason: null });
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
    expect(screen.getByText('R 25 000.00')).toBeTruthy();
    fireEvent.blur(input());
    expect(screen.getByText('R 25 000.00')).toBeTruthy();
    expect(input().value).toBe('25\xa0000.00');
  });

  it('points aria-describedby at the echo', () => {
    render(<Harness />);
    type('1234.5');
    const echo = screen.getByText('R 1 234.50');
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
    expect(screen.queryByText(/^\u2212R\s/u)).toBeNull();
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toMatch(/negative/i);
    expect(out()).toBe('null');
    unmount();
    render(<Harness allowNegative />);
    type('-5');
    fireEvent.blur(input());
    expect(out()).toBe('-500');
    expect(screen.getByText(/^\u2212R\s5\.00$/u)).toBeTruthy();
  });

  it('enforces min and max in cents', () => {
    render(<Harness min={1_000} max={5_000} />);
    type('5');
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toMatch(/at least R\xa010\.00/);
    type('60');
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toMatch(/at most R\xa050\.00/);
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
    expect(screen.getByText('USD 25 000.00')).toBeTruthy();
  });

  it('follows an outside change to value', () => {
    const { rerender } = render(<MoneyField label="Amount" value={100} onChange={() => undefined} />);
    expect(input().value).toBe('1.00');
    rerender(<MoneyField label="Amount" value={250_000} onChange={() => undefined} />);
    expect(input().value).toBe('2\xa0500.00');
  });

  it('keeps unreadable text on screen after it reports null', () => {
    render(<Harness initial={500} />);
    type('abc');
    fireEvent.blur(input());
    expect(out()).toBe('null');
    expect(input().value).toBe('abc');
  });

  it('reports a refusal even when the value stays null (empty field, then junk): the form must not submit', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    type('abc');
    fireEvent.blur(input());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBeNull();
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ valid: false });
    expect(spy.mock.calls[0]?.[1].reason).toMatch(/digits/);
    type('5');
    fireEvent.blur(input());
    expect(spy).toHaveBeenLastCalledWith(500, { valid: true, reason: null });
    type('');
    fireEvent.blur(input());
    expect(spy).toHaveBeenLastCalledWith(null, { valid: true, reason: null });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does not repeat an unchanged refusal on every blur', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    type('abc');
    fireEvent.blur(input());
    fireEvent.blur(input());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('min and max are inclusive', () => {
    render(<Harness min={1_000} max={5_000} />);
    type('10');
    fireEvent.blur(input());
    expect(out()).toBe('1000');
    expect(screen.queryByRole('alert')).toBeNull();
    type('50');
    fireEvent.blur(input());
    expect(out()).toBe('5000');
    expect(screen.queryByRole('alert')).toBeNull();
    type('50.01');
    fireEvent.blur(input());
    expect(out()).toBe('null');
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('passes onBlur through after committing', () => {
    const onBlur = vi.fn();
    render(<Harness onBlur={onBlur} />);
    type('12');
    fireEvent.blur(input());
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(out()).toBe('1200');
  });

  it('a USD field refuses an R / ZAR prefix rather than reading it as dollars', () => {
    render(<Harness currency="USD" />);
    type('R 5');
    fireEvent.blur(input());
    expect(out()).toBe('null');
    expect(screen.getByRole('alert').textContent).toMatch(/USD/);
    type('ZAR 5');
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toMatch(/USD/);
    type('5');
    fireEvent.blur(input());
    expect(out()).toBe('500');
  });

  it('refuses more than the money ceiling', () => {
    render(<Harness />);
    type('10 000 000 000 000.00');
    fireEvent.blur(input());
    expect(screen.getByRole('alert').textContent).toMatch(/R\xa09\xa0999\xa0999\xa0999\xa0999\.99/);
  });

  it('posts the canonical cents through a hidden input, never the display text', () => {
    const { container } = render(<Harness name="amount" initial={2_500_000} />);
    const hidden = container.querySelector('input[type="hidden"][name="amount"]') as HTMLInputElement;
    expect(hidden.value).toBe('2500000');
    expect(input().getAttribute('name')).toBeNull();
    type('1,5');
    fireEvent.blur(input());
    expect(hidden.value).toBe('150');
    type('abc');
    fireEvent.blur(input());
    expect(hidden.value).toBe('');
  });

  it('has no hidden input without a name', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
  });

  it('a form reset clears refused text: the value was null and stays null, so resetKey does it', () => {
    const spy = vi.fn();
    const { rerender } = render(
      <MoneyField label="Amount" value={null} onChange={spy} resetKey={0} />,
    );
    fireEvent.change(input(), { target: { value: 'abc' } });
    fireEvent.blur(input());
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(input().value).toBe('abc');
    rerender(<MoneyField label="Amount" value={null} onChange={spy} resetKey={0} />);
    expect(input().value).toBe('abc');
    rerender(<MoneyField label="Amount" value={null} onChange={spy} resetKey={1} />);
    expect(input().value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input().getAttribute('aria-invalid')).toBe('false');
    // the refusal is forgotten: the same junk is news again
    spy.mockClear();
    fireEvent.change(input(), { target: { value: 'abc' } });
    fireEvent.blur(input());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a reset also restores the value the parent passes in the same render', () => {
    const { rerender } = render(<MoneyField label="Amount" value={500} onChange={() => undefined} resetKey="a" />);
    fireEvent.change(input(), { target: { value: '99' } });
    rerender(<MoneyField label="Amount" value={500} onChange={() => undefined} resetKey="b" />);
    expect(input().value).toBe('5.00');
  });
});
