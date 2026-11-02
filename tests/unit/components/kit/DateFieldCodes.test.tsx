import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateField, type DateFieldProps } from '@/components/ui/DateField';

// 10:00 SAST on Thursday 15 Oct 2026.
const TODAY = (): Date => new Date('2026-10-15T08:00:00Z');

function Harness(props: Partial<DateFieldProps> & { spy?: DateFieldProps['onChange'] }) {
  const { spy, ...rest } = props;
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <DateField label="To" value={value} getToday={TODAY} onChange={(v, validity) => { spy?.(v, validity); setValue(v); }} {...rest} />
      <output data-testid="out">{value ?? 'null'}</output>
    </>
  );
}

const commit = (text: string): void => {
  const input = screen.getByRole('textbox', { name: 'To' });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
};

describe('DateField refusal codes', () => {
  it.each<[string, Partial<DateFieldProps>, string]>([
    ['unreadable', {}, 'garbage'],
    ['before-min', { minDate: '2026-10-01' }, '1 Sep 2026'],
    ['after-max', { maxDate: '2026-10-31' }, '1 Nov 2026'],
  ])('%s', (code, props, text) => {
    const spy = vi.fn();
    render(<Harness spy={spy} {...props} />);
    commit(text);
    expect(spy).toHaveBeenLastCalledWith(null, { valid: false, code, reason: expect.any(String) });
  });

  it('empty, when required; the default message text is unchanged', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} required />);
    commit('x');
    commit('');
    expect(spy).toHaveBeenLastCalledWith(null, { valid: false, code: 'empty', reason: 'Enter a date.' });
  });

  it('a valid date has code null', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    commit('1 Oct 2026');
    expect(spy).toHaveBeenLastCalledWith('2026-10-01', { valid: true, code: null, reason: null });
  });
});

describe('DateField anchorDate', () => {
  it('eom counts from the anchor: "1 Sep 2026" + eom = 30 Sep 2026', () => {
    render(<Harness anchorDate="2026-09-01" />);
    commit('eom');
    expect(screen.getByTestId('out').textContent).toBe('2026-09-30');
  });

  it('+30 counts from the anchor', () => {
    render(<Harness anchorDate="2026-09-01" />);
    commit('+30');
    expect(screen.getByTestId('out').textContent).toBe('2026-10-01');
  });

  it('without an anchor eom is this month', () => {
    render(<Harness />);
    commit('eom');
    expect(screen.getByTestId('out').textContent).toBe('2026-10-31');
  });
});
