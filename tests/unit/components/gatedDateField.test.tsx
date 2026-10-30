import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useState } from 'react';
import { GatedDateField, useDateGate } from '@/components/forms/GatedDateField';

function Harness(): JSX.Element {
  const [d, setD] = useState('2026-10-01');
  const [shown, setShown] = useState(true);
  const [seen, setSeen] = useState('');
  const gate = useDateGate();
  return (
    <div>
      {shown && <GatedDateField label="When" value={d || null} gate={gate} gateKey="when" onValue={setD} />}
      <button type="button" onClick={() => setShown(false)}>hide</button>
      <button type="button" onClick={() => setD('2026-11-02')}>scan</button>
      <output data-testid="iso">{d}</output>
      {/* blocked is a getter read at call time; sampling it in a handler sees what the last render bound */}
      <button type="button" onClick={() => setSeen(String(gate.blocked))}>check</button>
      <output data-testid="blocked">{seen}</output>
    </div>
  );
}

const blocked = (): string | null => {
  fireEvent.click(screen.getByText('check'));
  return screen.getByTestId('blocked').textContent;
};

const type = (text: string): void => {
  const input = screen.getByRole('textbox', { name: /when/i });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
};

it('blocks on refused text and keeps the stored date', () => {
  render(<Harness />);
  type('zz');
  expect(blocked()).toBe('true');
  expect(screen.getByTestId('iso').textContent).toBe('2026-10-01');
});

it('drops the refusal when the field unmounts', () => {
  render(<Harness />);
  type('zz');
  expect(blocked()).toBe('true');
  fireEvent.click(screen.getByText('hide'));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(blocked()).toBe('false');
});

it('drops the refusal when the parent sets a new value', () => {
  render(<Harness />);
  type('zz');
  expect(blocked()).toBe('true');
  fireEvent.click(screen.getByText('scan'));
  expect(screen.getByTestId('iso').textContent).toBe('2026-11-02');
  expect(blocked()).toBe('false');
});
