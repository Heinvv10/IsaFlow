import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useState } from 'react';
import { DateField } from '@/components/ui';
import { useDateGate } from '@/hooks/useDateGate';

function Probe(): JSX.Element {
  const [d, setD] = useState('2026-10-01');
  const gate = useDateGate();
  return (
    <div>
      <DateField label="When" value={d || null} onChange={gate.bind('when', setD)} />
      <output data-testid="iso">{d}</output>
      <output data-testid="blocked">{String(gate.blocked)}</output>
    </div>
  );
}

const type = (text: string): void => {
  const input = screen.getByRole('textbox', { name: /when/i });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
};

it('stores typed text as ISO and is not blocked', () => {
  render(<Probe />);
  type('5 Oct 2026');
  expect(screen.getByTestId('iso').textContent).toBe('2026-10-05');
  expect(screen.getByTestId('blocked').textContent).toBe('false');
});

it('blocks, keeping the old date, on refused text, and unblocks once a date is typed', () => {
  render(<Probe />);
  type('zz');
  expect(screen.getByTestId('blocked').textContent).toBe('true');
  expect(screen.getByTestId('iso').textContent).toBe('2026-10-01');
  type('t');
  expect(screen.getByTestId('blocked').textContent).toBe('false');
});

it('tracks fields independently', () => {
  const { result } = renderHook(() => useDateGate());
  const a = result.current.bind('a', () => undefined);
  const b = result.current.bind('b', () => undefined);
  act(() => a(null, { valid: false, reason: 'x' }));
  act(() => b(null, { valid: true, reason: null }));
  expect(result.current.blocked).toBe(true);
});
