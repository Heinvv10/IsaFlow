import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MoneyField, type MoneyFieldProps } from '@/components/ui/MoneyField';

function Harness(props: Partial<MoneyFieldProps> & { spy?: MoneyFieldProps['onChange'] }) {
  const { spy, ...rest } = props;
  const [value, setValue] = useState<number | null>(null);
  return <MoneyField label="Amount" value={value} onChange={(v, validity) => { spy?.(v, validity); setValue(v); }} {...rest} />;
}

const commit = (text: string): void => {
  const input = screen.getByRole('textbox', { name: 'Amount' });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
};

describe('MoneyField refusal codes', () => {
  it.each<[string, Partial<MoneyFieldProps>, string]>([
    ['unreadable', {}, 'abc'],
    ['negative', {}, '-5'],
    ['below-min', { min: 1_000 }, '5'],
    ['above-max', { max: 1_000 }, '50'],
  ])('%s', (code, props, text) => {
    const spy = vi.fn();
    render(<Harness spy={spy} {...props} />);
    commit(text);
    expect(spy).toHaveBeenLastCalledWith(null, { valid: false, code, reason: expect.any(String) });
  });

  it('empty, when required; the default message text is unchanged', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} required />);
    commit('1');
    commit('');
    expect(spy).toHaveBeenLastCalledWith(null, { valid: false, code: 'empty', reason: 'Enter an amount.' });
  });
});
